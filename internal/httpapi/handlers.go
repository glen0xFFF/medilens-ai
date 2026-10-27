package httpapi

import (
	"net/http"
	"slices"
	"unicode/utf8"

	"github.com/medilens-ai/medilens/internal/application"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/domain"
	"github.com/medilens-ai/medilens/internal/middleware"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

// created is the 202 answer of a create: the analysis runs on a worker.
type created struct {
	ID     string            `json:"id"`
	Status application.State `json:"status"`
}

type readyBody struct {
	Status string      `json:"status"`
	Checks readyChecks `json:"checks"`
}

func (a *API) notFound(w http.ResponseWriter, r *http.Request) {
	middleware.WriteError(w, r, http.StatusNotFound, contracts.ErrNotFound, "Not found.")
}

// healthz is liveness only: no dependency is checked.
func (a *API) healthz(w http.ResponseWriter, _ *http.Request) {
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// readyz names the providers without calling them; 503 once shutdown has
// begun.
func (a *API) readyz(w http.ResponseWriter, _ *http.Request) {
	if a.notReady.Load() {
		middleware.WriteJSON(w, http.StatusServiceUnavailable, readyBody{Status: "shutting_down", Checks: a.checks})
		return
	}
	middleware.WriteJSON(w, http.StatusOK, readyBody{Status: "ready", Checks: a.checks})
}

func (a *API) capabilities(w http.ResponseWriter, _ *http.Request) {
	middleware.WriteJSON(w, http.StatusOK, a.svc.Capabilities())
}

func (a *API) presets(w http.ResponseWriter, _ *http.Request) {
	middleware.WriteJSON(w, http.StatusOK, slices.Clone(domain.AllowedQuestionExamples))
}

func (a *API) demoScenarios(w http.ResponseWriter, _ *http.Request) {
	middleware.WriteJSON(w, http.StatusOK, demo.Summaries())
}

// pathID is the {id} path value. One that is not UTF-8 once
// percent-decoded is the client's error, as Express's failed parameter
// decoding was (final review Minor 13).
func pathID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if !utf8.ValidString(id) {
		writeError(w, r, pipeline.NewError(contracts.ErrValidationFailed))
		return "", false
	}
	return id, true
}

// createAnalysis is POST /analyses: the upload is checked synchronously,
// then the analysis is accepted (202) and runs on a worker.
func (a *API) createAnalysis(w http.ResponseWriter, r *http.Request) {
	images, perr := readImages(w, r)
	if perr != nil {
		writeError(w, r, perr)
		return
	}
	id, err := a.svc.Create(r.Context(), images)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusAccepted, created{ID: id, Status: application.StateProcessing})
}

// createDemo is POST /demo/scenarios {scenarioId}: the real pipeline on the
// scenario's fixtures, whatever the providers and the budget.
func (a *API) createDemo(w http.ResponseWriter, r *http.Request) {
	fields, perr := readJSONObject(w, r)
	if perr != nil {
		writeError(w, r, perr)
		return
	}
	// a missing or non-string id is "" for the service: VALIDATION_FAILED
	scenarioID, _ := stringField(fields, "scenarioId")
	id, err := a.svc.CreateDemo(r.Context(), scenarioID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusAccepted, created{ID: id, Status: application.StateProcessing})
}

// status is GET /analyses/{id}: the state, current stage and events. The
// stored error of a failed analysis carries this request's id.
func (a *API) status(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	st, err := a.svc.Status(id)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if st.Events == nil {
		st.Events = []pipeline.Event{}
	}
	if st.Error != nil {
		e := *st.Error
		e.RequestID = middleware.RequestIDFrom(r.Context())
		st.Error = &e
	}
	middleware.WriteJSON(w, http.StatusOK, st)
}

// result is GET /analyses/{id}/result: 409 ANALYSIS_NOT_READY while
// processing, the stored error on failure.
func (a *API) result(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	res, err := a.svc.Result(id)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, res)
}

// explanation is POST /analyses/{id}/explanation {question}: the Node
// explain route. The body must be JSON first (express.json ran before the
// route); then the id is checked before the question, as storedResult ran
// before the schema.
func (a *API) explanation(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	fields, perr := readJSONObject(w, r)
	if perr != nil {
		writeError(w, r, perr)
		return
	}
	// a missing or non-string question is "" for the service, which checks
	// the id first and then answers VALIDATION_FAILED
	question, _ := stringField(fields, "question")
	answer, err := a.svc.Explain(r.Context(), id, question)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, answer)
}

// speak is POST /analyses/{id}/speak {target: "summary"} or {target:
// "answer", text}: text for the device's speech engine.
func (a *API) speak(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	fields, perr := readJSONObject(w, r)
	if perr != nil {
		writeError(w, r, perr)
		return
	}
	target, _ := stringField(fields, "target")
	text, _ := stringField(fields, "text")
	speech, err := a.svc.Speak(id, application.SpeakTarget(target), text)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, speech)
}

func (a *API) references(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	refs, err := a.svc.References(id)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, refs)
}

// deleteAnalysis drops the result and events: 204.
func (a *API) deleteAnalysis(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := a.svc.Delete(id); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
