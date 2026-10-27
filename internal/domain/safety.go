package domain

// Port of apps/server/src/domain/safety.ts: the deterministic question
// safety gate (spec §4.3 step 1). It runs before any model call and is
// DEFAULT-DENY (Task 5b controller ruling):
//
//  1. Normalise (NFKC, strip invisible format characters, lowercase, quotes,
//     whitespace, trailing punctuation); an empty question or one over 300
//     UTF-16 code units is refused as outside_label.
//  2. Refusal patterns run first and win, even inside a label-reading form:
//     possible overdose, then the named refusal lists, then the structural
//     gate, then modal dose talk about any person ("should she redose?").
//  3. English only: a question with any character outside printable ASCII
//     left after normalisation is refused as outside_label. This runs after
//     the refusals so the emergency text is never lost to it.
//  4. A question is allowed ONLY when the whole normalised question matches
//     one of the anchored allow templates (questions about printed content).
//  5. Everything else is refused as outside_label.
//
// How the TS regular expressions are re-expressed: every pattern here is
// the exact TS pattern text (the same building blocks concatenated in the
// same way, the regex literals copied verbatim), run by internal/jsregex,
// which implements ECMAScript RegExp semantics for flagless patterns:
// lookahead, lookbehind (matched right to left), lazy quantifiers, ASCII \b
// and \w, JS \s, and UTF-16 code units. Go's RE2 supports none of the
// lookarounds. TestSafetyRegexpSources proves the set of pattern texts
// equals the set V8 ran; TestSafetyRegexpMatrix proves the matcher agrees
// with V8 on each of them over every recorded text. The three /g RegExps in
// normalise and the u-flag INVISIBLE class are hand-written below:
// TestJSUnicodeTables checks \s, the invisible class, toLowerCase and NFKC
// per code point against V8, and the adversarial corpus covers the quote
// mapping and whitespace runs.
//
// Building blocks keep their TS names in camelCase; each comment of the TS
// source applies unchanged.

import (
	"encoding/json"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/jsregex"
)

// RefusalReason is why a question is refused.
type RefusalReason string

// The refusal reasons, as in the TS union.
const (
	RefusalPersonalDose       RefusalReason = "personal_dose"
	RefusalStartStop          RefusalReason = "start_stop"
	RefusalDiagnosis          RefusalReason = "diagnosis"
	RefusalSpecialPopulation  RefusalReason = "special_population"
	RefusalInteraction        RefusalReason = "interaction"
	RefusalPersonalSafety     RefusalReason = "personal_safety"
	RefusalPillIdentification RefusalReason = "pill_identification"
	RefusalPossibleOverdose   RefusalReason = "possible_overdose"
	RefusalOutsideLabel       RefusalReason = "outside_label"
)

// AllowedIntent is what an allowed question asks for.
type AllowedIntent string

// The allowed intents, as in the TS union.
const (
	IntentReadLabel    AllowedIntent = "read_label"
	IntentExplainText  AllowedIntent = "explain_text"
	IntentStrength     AllowedIntent = "strength"
	IntentUnclearParts AllowedIntent = "unclear_parts"
	IntentRegistry     AllowedIntent = "registry"
	IntentOtherLabel   AllowedIntent = "other_label"
)

// QuestionClass is the TS union {allowed:true,intent} |
// {allowed:false,reason}: Intent is set only when Allowed, Reason only when
// not.
type QuestionClass struct {
	Allowed bool
	Intent  AllowedIntent
	Reason  RefusalReason
}

// MarshalJSON encodes the TS shape, never both keys.
func (c QuestionClass) MarshalJSON() ([]byte, error) {
	if c.Allowed {
		return json.Marshal(struct {
			Allowed bool          `json:"allowed"`
			Intent  AllowedIntent `json:"intent"`
		}{true, c.Intent})
	}
	return json.Marshal(struct {
		Allowed bool          `json:"allowed"`
		Reason  RefusalReason `json:"reason"`
	}{false, c.Reason})
}

func refused(r RefusalReason) QuestionClass { return QuestionClass{Reason: r} }

const redirect = "Please ask a pharmacist or your doctor."

// Overdose reports that slip past the possible_overdose patterns land in
// these reasons, so their texts carry the emergency safety net (controller
// ruling, Task 5b breaker).
const safetyNet = "If someone has already taken too much, call 911."

// RefusalText is the fixed text spoken for each refusal. Treat as read-only.
var RefusalText = map[RefusalReason]string{
	RefusalPersonalDose:       "I can't tell you how much to take. I can only read what is printed on the label. " + safetyNet + " " + redirect,
	RefusalStartStop:          "I can't advise you to start, stop or change a medicine. " + redirect,
	RefusalDiagnosis:          "I can't diagnose symptoms or say whether this medicine treats them. " + redirect,
	RefusalSpecialPopulation:  "I can't say whether this medicine is suitable for children, older people, or during pregnancy or breastfeeding. " + safetyNet + " " + redirect,
	RefusalInteraction:        "I can't check whether this medicine is safe to take with other medicines, food or alcohol. " + safetyNet + " " + redirect,
	RefusalPersonalSafety:     "I can't say whether this medicine is safe for you. " + safetyNet + " " + redirect,
	RefusalPillIdentification: "I can't identify a medicine from how a pill looks. " + redirect,
	RefusalPossibleOverdose:   "If someone may have taken too much of this medicine, call 911 or go to the nearest emergency room now.",
	RefusalOutsideLabel:       "I can only read and explain what is printed on this label. For questions about whether or how to take it, please ask a pharmacist or your doctor.",
}

// AllowedQuestionExamples are the canonical preset questions; the mobile
// app shows these as buttons. Each one is allowed. Treat as read-only.
var AllowedQuestionExamples = []string{
	"Can you read this label?",
	"What does this warning mean?",
	"What strength is printed here?",
	"Explain the directions in simpler words.",
	"Which parts were unclear?",
	"What did the FDA registry say?",
	"Who makes this medicine?",
	"What is the expiry date on the pack?",
	"How should it be stored?",
	"Can you repeat that?",
}

// maxQuestionChars is the longest question the gate considers, in UTF-16
// code units (spec §5.1 explain body: question ≤ 300 chars).
const maxQuestionChars = 300

// namedPattern is one compiled safety RegExp and its TS location.
type namedPattern struct {
	name string
	re   *jsregex.Regexp
}

// safetyPatterns lists every RegExp of the gate, for the source and matrix
// tests.
var safetyPatterns []namedPattern

// re compiles one TS pattern text (a literal's source or a new RegExp
// argument) and registers it.
func re(name, source string) *jsregex.Regexp {
	r := jsregex.MustCompile(source)
	safetyPatterns = append(safetyPatterns, namedPattern{name, r})
	return r
}

// reList compiles a TS RegExp array, naming each NAME[i].
func reList(name string, sources ...string) []*jsregex.Regexp {
	out := make([]*jsregex.Regexp, len(sources))
	for i, s := range sources {
		out[i] = re(name+"["+strconv.Itoa(i)+"]", s)
	}
	return out
}

/* ------------------------------------------------------ building blocks */

var (
	pill       = `(?:pills?|tablets?|capsules?|caplets?|tabs?)`
	subject    = `(?:i|you|he|she|we|they|someone|anyone|my \w+|\w+s)`
	count      = `(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|half|a)`
	bareCount  = `(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|half)`
	amountUnit = `(?:` + pill + `|mg|mcg|ml|g|doses?|teaspoons?|tsp|tablespoons?|tbsp|spoons?|drops?|sachets?)`
	condition  = `(?:diabet\w*|blood pressure|hypertensi\w*|kidneys?|renal|liver|heart|asthma\w*|ulcers?)`
	looks      = `(?:white|yellow|pink|blue|red|orange|green|brown|purple|grey|gray|black|round|oval|oblong|small|big|large|tiny|loose|scored|coated|shiny)`

	countWord2Plus = `(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|dozens?|couple|several|many|multiple|lots|loads|heaps|tons)`
	container      = `(?:bottles?|packs?|packets?|box(?:es)?|strips?|blisters?|jars?|tubs?|sachets?|containers?|tubes?|cartons?|vials?|syrups?|contents|supply|lot)`
	doseForms      = `(?:pills|tablets|capsules|caplets|tabs|caps|meds|medicines|doses)`
	notMedicine    = `(?:hours?|hrs?|minutes?|mins?|seconds?|days?|nights?|mornings?|evenings?|afternoons?|weeks?|months?|years?|yrs?|time|beers?|drinks?|glass(?:es)?|cups?|shots?|coffees?|kids?|children|people|persons?|meals?|am|pm|o'?clock|kg|kilos?|lbs?|pounds?|questions?|photos?|pictures?|care|caution|precautions?)`
	medicineWord   = `\b(?:pills?|tablets?|tabs?|capsules?|caps|caplets?|syrups?|medic\w*|meds|gumm\w*|vitamins?|magnesia|chewables?|doses?|dosage|drops|drugs?|lozenges?|sachets?|supplements?|paracetamol|acetaminophen|ibuprofen|aspirin|antibiotics?|ointment|cream|laxatives?|antacids?|antihistamines?|painkillers?|sedatives?|decongestants?|suppositor\w*)\b`
	medicineNext   = `(?:'| (?!(?:and|or|with|then|but|so|to|of|in|on|at|for|from|after|before)\b)(?:[\w']+ ){0,2}?` + medicineWord + `)`
	tooMuch        = `(?:one too many\b|(?:an |some |one |1 |a (?:little(?: bit)?|bit|tad) )?extra\b(?! strength)|(?:a |the |my |his |her |their )?(?:double|triple|quadruple)\b(?![ -]check| strength))`
	intensifier    = `(?:wa+y+|far|much|a lot|a bit|a little(?: bit)?|a tad|slightly|really|just|so|very|definitely|probably)`
	tooOrSo        = `(?:(?:` + intensifier + `,? ){0,3}(?:too|so) (?:much|many)|(?:one|1|a|an) (?:or|to) [\w']+ too many)\b`
	theCount       = `(?:the|these|those|my|his|her|their|our) (?:(?:last|remaining|other|first|next|extra|whole) )?(?:` + countWord2Plus + `|(?:[2-9]|[1-9]\d+)(?:\.\d+)?(?!\.?\d))\b(?! ?(?:mg|mcg|g|ml|cc|iu|%|milligrams?|grams?)\b)`
	excessPrefix   = `(?:(?:like|about|around|maybe|probably|at least|over|more than|almost|nearly|roughly|perhaps|quite) )?`
	oneDoseTooMany = `(?:one|1|a|an) (?:extra )?(?:dose|pill|tablet|capsule|caplet|tab|cap|spoonful|teaspoon|tablespoon|sachet) too many\b`
	excessAmount   = `(?:(?:[2-9]|[1-9]\d+)(?:\.\d+)?|` + countWord2Plus + `\b|a (?:couple|few|bunch|lot|handful|load|ton|heap|fistful|mouthful|dozen|boatload|truckload|bucketload|shedload|pile|stack)\b|plenty of (?:(?:the|my|his|her|their|these|those) )?(?:[\w'-]+ ){0,2}?` + medicineWord + `|(?:(?:a |one )?(?:quarter|third|fifth)|(?:two|three) (?:quarters|thirds)|most|(?:a |one )?(?:good |big |large |huge )?(?:chunk|part|portion)) of (?:the |a |an |my |his |her |their |this |that )?(?:\w+ )?(?:` + container + `|` + doseForms + `)\b|handfuls?\b|bunch(?:es)?\b|` + tooMuch + `|all\b|(?:them|these|those) all\b|everything\b|(?:the |a |an |my |his |her |their |our )?(?:whole|entire|full|rest of the|remaining|leftover|left over) (?:\w+ )?(?:` + container + `|` + doseForms + `|things?|(?:sheets?|cards?|rows?) of)\b|` + theCount + `|(?:a|the) pair(?: of (?:them|these|those|em|'em|` + doseForms + `)\b|\b(?! of\b))|` + oneDoseTooMany + `|the rest(?: of (?:it|them|these|those|mine))?\b(?! of\b))`
	ownerPerson    = `(?:kids?|children|people|persons?)`
	notMedAfter    = `(?! ?(?:of )?(?:(?!` + ownerPerson + `\b)` + notMedicine + `\b|` + ownerPerson + `\b(?!` + medicineNext + `)))`
	excess         = excessPrefix + `(?:` + excessAmount + `|` + tooOrSo + `|(?:the |a |an |my |his |her |their |our |half (?:the|a|of the) )(?:\w+ )?` + container + `\b)` + notMedAfter
	givenExcess    = excessPrefix + `(?:` + excessAmount + `|half (?:the|a|of the) (?:\w+ )?` + container + `\b)` + notMedAfter
	notPassive     = `(?<!\b(?:be|been|being|is|are|was|were|get|gets|got|to)(?: it| this| that| they| these| those)? )`
	ingested       = `(?:took|taken|swallowed|popped|downed|used|consumed|gobbled|chugged|gulped|guzzled|inhaled|finished|wolfed|scoffed|devoured|chewed|necked|snorted|injected|knocked|polished|ingested|sipped|slurped|licked|sucked|munched|drained|scarfed|crunched|(?:sucked|chewed|munched|nibbled) on|(?:tossed|threw|thrown) back|binged on|overindulged in|loaded up on|self[- ]medicated with|dosed (?:myself|himself|herself|themselves|ourselves|him|her|them) (?:up )?(?:with|on)|(?:ended|wound) up (?:taking|swallowing|using|popping|downing|chugging))`
	ingestedFood   = `(?:ate|eaten|drank|drunk|had|(?:ended|wound) up (?:having|drinking|eating))`
	particle       = `(?: (?:down|back|off|through|up))?`
	gave           = `(?:\b(?:gave|administered)|(?<!\b(?:be|is|are|being|to|gets?)(?: it| this| that| they| these| those)? )\bgiven|\b(?:ended|wound) up giving)`
	recipientWord  = `(?!(?:the|a|an|my|his|her|their|our|your|this|that|these|those|some|it|its|them|too|so|more|another|both|all|half|one|extra|double|twice)\b)[\w']+`
	recipientReq   = ` (?:him|her|them|myself|himself|herself|themselves|(?:my|his|her|their|our|your|the|a|an) (?:` + recipientWord + ` ){0,3}?` + recipientWord + `|(?!(?:me|us|up|away|back|out|in|off|birth|blood|way|rise|notice|permission|consent|instructions?|directions?|advice)\b)` + recipientWord + `)`
	recipient      = `(?:` + recipientReq + `)?`
	tookVerb       = `(?:` + notPassive + `\b` + ingested + particle + `|` + gave + recipient + `)`
	age            = `(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen)[ -]?(?:(?:years?|yrs?|months?|mos?|weeks?|wks?)[ -]?old|y\.?o\.?)`
	child          = `(?:kids?|child|children|baby|babies|toddlers?|infants?|newborns?|little ones?|sons?|daughters?|grand(?:son|daughter|child|kid)s?|(?:step|god)(?:sons?|daughters?|kids?|child(?:ren)?)|boys?|girls?|(?:little|baby|younger) (?:brothers?|sisters?)|kiddos?|tots?|nephews?|nieces?|anak|bata|sanggol|` + age + `)`
	childGap       = `(?:[\w']+ ){0,3}?`
	childIngested  = `(?:ate|eaten|eating|swallowed|swallowing|drank|drunk|drinking|took|taken|had|popped|chewed|chewing|sucked|sucking|licked|licking|consumed|gulped|guzzled|chugged|gobbled|downed|bit|bitten|biting|tasted|tasting)`
	childParticle  = `(?: (?:down|up|on|at|into|through|off))?`
	takenDose      = `(?:my|his|her|their|our|the|a|this|that) (?:\w+ )?(?:dose|doses|` + pill + `|medicines?|medications?|meds|syrup)`
	takenThing     = `(?:it|them|one|` + takenDose + `)`
	repeated       = `(?:twice|thrice|(?:two|three|four|2|3|4) times|a second time|[2-9] ?x|x ?[2-9])\b(?! ?(?:a|per|each|every) (?:day|night|week|morning|evening)\b| ?(?:daily|nightly|weekly)\b)`
	childDoseNoun  = `(?:pills?|tablets?|capsules?|caplets?|tabs?|caps|medicines?|medications?|meds|syrups?|drops|doses?|vitamins?|gummies|amounts?|quantit(?:y|ies))`
	sizeWord       = `(?:large|big|high|huge|massive|excessive|enormous|giant|gigantic|hefty|heavy|whopping|great|substantial|significant|considerable|sizeable|sizable|generous|crazy|insane|ridiculous|stupid|silly|absurd|obscene|ungodly|monster|mega|astronomical|tremendous|colossal|immense|dangerous|unsafe|extreme|unknown|larger|bigger|higher|greater|heavier)`
	sizeIntens     = `(?:(?:very|really|super|quite|pretty|rather|fairly|extremely|dangerously|seriously|insanely|ridiculously|way|much|far|even|overly|excessively|unusually|abnormally|incredibly) )?`
	sizeDoseMod    = `(?:(?:single|daily|extra|first|second|whole|full|adult|night|nightly|morning|evening|initial|total) )?`
	sizeNoun       = `(?:amount|number|quantity|dose|dosage|handful|fistful|spoonful|mouthful|gulp|swig|helping|portion|serving|volume)`
	sizeNouns      = `(?:amounts|numbers|quantities|doses|dosages|handfuls|fistfuls|spoonfuls|mouthfuls|gulps|swigs|helpings|portions|servings|volumes)`
	sizeAmount     = `(?:(?:such )?an? ` + sizeIntens + sizeWord + ` ` + sizeDoseMod + sizeNoun + `|` + sizeIntens + sizeWord + ` ` + sizeDoseMod + sizeNouns + `|a (?:great|good) deal|an? mega-?dose|mega-?doses)\b`
	sizeDose       = `(?:(?:such )?an? ` + sizeIntens + sizeWord + ` ` + sizeDoseMod + `(?:dose|dosage)|` + sizeIntens + sizeWord + ` ` + sizeDoseMod + `(?:doses|dosages))\b`
	vessel         = `(?:cups?|cupfuls?|glass(?:es)?|glassfuls?|mugs?|mugfuls?|bottlefuls?|jugs?|pints?|tumblers?|beakers?)`
	vesselQuant    = `(?:(?:an?|one|1|half(?: an?| of an?)?|a half|one half|a whole|a full|the whole|the full|an entire|the entire|a couple(?: of)?|a few|several|` + countWord2Plus + `|\d+(?:\.\d+)?) )?(?:` + sizeIntens + `(?:` + sizeWord + `|tall|full|whole|entire) )?`
	countedMeasure = `(?:` + countWord2Plus + `|(?:[2-9]|[1-9]\d+)(?:\.\d+)?|a (?:few|couple)(?: of)?|several) (?:shots?|shot glass(?:es)?|capfuls?|swigs?|gulps?|sips?|spoonfuls?|mouthfuls?)`
	childMeasure   = vesselQuant + `(?:` + vessel + `(?: full)?|shot glass(?:es)?|bowls?|bowlfuls?|gulps?|swigs?|sips?|capfuls?|shots?|mouthfuls?|spoonfuls?|droppers?(?:fuls?)?) of`
	owner          = `(?:(?:a|an|the|my|his|her|their|our|your) )?(?:[a-z][\w-]* )?[a-z][\w-]*(?: in[- ]law)?(?:'s|s')`
	childObject    = `(?:some|one|it|them|all|any|a few|a bunch|a lot|a handful|a couple|several|many|\d+|` + countWord2Plus + `|(?:` + intensifier + `,? ){0,3}(?:too|so) (?:much|many)|` + childMeasure + `|(?:a|an|the|my|his|her|their|our|your)(?: [\w'-]+){0,2} (?:` + childDoseNoun + `|` + container + `|spoonfuls?|sips?|bites?|bits?|pieces?)|` + owner + `(?: [\w'-]+){0,2} (?:` + childDoseNoun + `|` + container + `)|(?!(?:no|not|never|none|zero)\b)(?:(?:out of|from|off) )?(?:[\w'-]+ ){0,2}` + childDoseNoun + `)`
	childFood      = `(?:water|juice|milk|formula|food|rice|soup|tea|bread|fruit|cereal|breakfast|lunch|dinner|snacks?|meals?)`
	foodNext       = `(?:can|could|is|was|are|were|should|will|would|did|does|do|may|might|now|today|tonight|earlier|yesterday|this (?:morning|afternoon|evening)|he|she|they|i|we|you|after|before|went|fell|seems?|seemed|looks?|looked|feels?|felt|just|only)\b`
	foodEnd        = `(?=[,.?!;]*$|[,.?!;]* (?:(?:and|then|but|so)(?: then)? )?` + foodNext + `)`
	clauseEnd      = `(?:[,.?!;]|$| (?:and|then|but|so|can|could|is|was|should|will|would|now|today)\b)`
	childAccess    = `(?:got into|gotten into|got in to|got (?:a )?hold of|got ahold of|got at|got (?:his |her |their |its )?hands? on|grabbed|found|opened|reached)`
	foodMod        = `(?:orange|apple|grape|pineapple|mango|lemon|lime|coconut|chocolate|strawberry|banana|fruit|sugar|warm|cold|hot|iced|plain|fresh|breast|cow's|soy|almond|oat|whole|skim|baby|chicken|vegetable|green|black|tap|bottled|boiled|filtered|mineral|sparkling)`
	notChildFood   = `(?! (?:of )?(?:the |his |her |their |my |your |a |an |some )?(?:` + foodMod + ` )?` + childFood + foodEnd + `(?!.*(?:` + medicineWord + `|\b(?:` + childIngested + `|` + childAccess + `)\b)))`
	adultFood      = `(?:` + childFood + `|coffee|caffeine|soda|softdrinks?|coke|cola|wine|beer|alcohol|liquor|booze|vodka|whisky|whiskey|rum|gin|tequila|cider|champagne|lager|ale|cocktails?|punch|lemonade|smoothies?|milkshakes?|cocoa|latte|cappuccino|espresso|broth|yogh?urt|porridge|oatmeal|ice cream|ice|pizza|cake|candy|chocolate|sweets|sugar|salt|dessert|chips|cookies|biscuits|crackers|popcorn|nuts|fries|burgers?|sandwich(?:es)?|chicken|fish|eggs|salad|meat|pasta|noodles|cheese|junk food|fast food)`
	notAThing      = `(?:(?:of|the|a|an|my|his|her|their|our|your|this|that|these|those|some|and|but|so|then|or|because|cause|since|when|while|after|before|until|till|at|in|on|for|during|over|with|without|to|today|tonight|yesterday|earlier|recently|lately|again|already|now|last|lol|haha|i|he|she|we|they|you|it)\b|(?:` + notMedicine + `|fun|work|homework|housework|paperwork|schoolwork|stress|pain|trouble|sleep|energy|screen|money|cash|dollars?|pesos?|bucks|effort|attention|thought|patience|love|sun|sunlight|exercise)\b(?!` + medicineNext + `))`
	foodTail       = `(?:and|or|but|then|so|because|cause|since|when|while|after|before|until|till|at|in|on|for|from|during|over|without|to|as|like|today|tonight|yesterday|earlier|recently|lately|again|already|now|last|this|that|these|those|lol|haha|tbh|rn|probably|maybe|honestly|though|tho|anyway|also|too|instead|every|each|per|daily|i|i'm|im|i've|ive|i'd|he|she|we|they|you|it|its|it's|me|my|his|her|their|our|your|the|a|an|can|could|should|would|will|is|was|did|do|does|am|are|were|has|have|had|may|might|must|which|who|please)`
	foodPhraseMod  = `(?:` + foodMod + `|milk|rice|coffee|ice|beer|wine|cheese|cream|peanut|cookie|candy|egg|potato|corn|tomato|beef|pork|fish|cake|sugar[- ]free|sugarless|diet|decaf|low[- ]fat|fat[- ]free|non[- ]?fat|skimmed)`
	foodPhraseTM   = foodPhrase(foodTail)                    // TS FOOD_PHRASE
	foodPhraseWith = foodPhrase(`(?:` + foodTail + `|with)`) // TS FOOD_PHRASE_WITH
	tooMuchThing   = `(?:of (?:it|them)\b|of (?:this|that|these|those)\b(?! [a-z])|(?:of )?(?:(?:the|my|his|her|their|our|your|this|that|these|those|some) )?(?!` + notAThing + `|` + foodPhraseTM + `)[a-z][\w'-]*)`
	ofThing        = `of (?:(?:it|them)\b|(?:this|that|these|those)\b(?! [a-z])|(?:(?:the|my|his|her|their|our|your|this|that|these|those|some) )?(?!` + notAThing + `|` + foodPhraseWith + `)[a-z][\w'-]*)`
	mouthObject    = `(?:` + childObject + `|something|(?:some|any|a few|a couple(?: of)?|several|many|` + countWord2Plus + `|\d+) (?:[\w'-]+ )?(?:pills?|tablets?|capsules?|caplets?|tabs?|caps|medicines?|meds|vitamins?|gummies)|(?:the )?(?:one|some|any|a few|a couple|several|half|` + countWord2Plus + `|\d+) of (?:them|these|those|it|mine|his|hers|theirs|ours|yours|(?:(?:the|my|his|her|their|your|our|these|those) )?(?:[\w'-]+ ){0,2}?(?:pills?|tablets?|capsules?|caplets?|tabs?|caps|medicines?|medications?|meds|vitamins?|gummies)))`
	mouthVerb      = `(?:put|puts|putting|stuck|sticks?|sticking|popped|popping|placed|placing|shoved|shoving|stuffed|stuffing|had|has|having|got|holding|held|with)`
	childS         = child + `(?:'s)?`
	morePrefix     = `(?: (?:` + takenThing + `|1|a (?:few|couple|lot|bit|little)|some|way|much|far|slightly|lots|loads|many))?`
	moreWord       = `(?:more|higher|greater|bigger|larger|stronger)`
	moreDoseNoun   = `(?:` + pill + `|caps|medicines?|medications?|meds|syrups?|doses?|drops|gummies|vitamins?)`
	moreDose       = `(?: (?:of (?:the|my|his|her|their|our|your|these|those|this|that) (?:\w+ )?` + moreDoseNoun + `|(?:\w+ )?` + moreDoseNoun + `))`
	moreNoun       = `(?: (?!than\b|` + notMedicine + `\b)[\w']+){0,4}?`
	thanWhat       = `(?:what(?:'s|s| is| was)? |(?:is|was) )?`
	thanMultiple   = `(?:twice|double|triple|thrice)\b`
	labelVerb      = `(?:says?|said|recommends?|recommended|allows?|allowed|states?|stated|directs?|directed|tells?|told|prescribes?|prescribed|advises?|advised|instructs?|instructed|suggests?|suggested|indicates?|indicated|ordered)`
	numberOf       = `number(?: of (?:(?:daily|individual|single|separate) )?(?:` + pill + `|caps|doses|meds|medicines|medications|spoonfuls|teaspoons|tablespoons|tbsps?|tsps?|ml|mls|millilit(?:er|re)s|mg|milligrams|grams|gummies|lozenges|puffs|sprays|squirts|drops|sachets|chewables|vitamins|times))?(?! of\b)`
	limitAdj       = `(?:recommended|daily|maximum|max|stated|prescribed|usual|normal|safe|printed|single|allowed|permitted|suggested|upper|label|labell?ed|correct|right|proper|standard|regular|indicated|directed|advised|specified|approved|acceptable|permissible|total|adult|(?:24|twenty[- ]four)[- ]hours?)`
	serving        = `servings?\b(?! of\b)`
	thanLabel      = `(?:(?:it|(?:the|its|my|his|her|their|our) (?:doctor|doc|pharmacist|physician|nurse)) ` + labelVerb + `|(?:the|its|my|his|her|their|our) (?:label|pack|box|bottle|leaflet|insert|directions?|instructions?|prescription)(?: ` + labelVerb + `)?|(?:printed |written |stated )?(?:on|in) (?:the|its|my|his|her|their) (?:label|pack|box|bottle|leaflet|insert|directions|instructions|prescription)|recommended|directed|prescribed|allowed|advised|instructed|indicated|stated|printed|written|(?:the |its |my |his |her |their |our |a )?(?:` + limitAdj + ` ){0,2}(?:dose|doses|dosage|amount|quantit(?:y|ies)|volume|` + serving + `|allowance|intake|limit|maximum|max|` + numberOf + `))\b`
	thanUsual      = `(?:usual|normal|normally|usually|(?:one|1)(?! (?:of )?` + notMedicine + `\b))\b`
	thanPerson     = `(?:i|im|you|youre|he|hes|she|shes|they|theyre|we)(?:'d|'m|'re|'s)? (?:should|shouldve|should've|ought|was|were|am|are|is|meant|supposed|allowed|told|advised|needed|need|wanted|had to|have to|has to|could|can|cant|can't|would|intended|planned|normally|usually|ever|did|do|does)\b`
	notIt          = `(?<!\b(?:it|that|this|which) )`
	both           = `both (?:of )?(?:the |my |his |her |their |our |these |those )?(?:[\w']+ ){0,4}?(?:doses?|pills?|tablets?|capsules?|caplets?|tabs|caps|medicines?|medications?|meds)\b`
	bothThem       = `(?:(?:the )?both(?: of)? (?:them|these|those|em|'em)\b|(?:them|these|those|em|'em) both\b|(?:the )?both\b(?=` + clauseEnd + `| (?:at once|at the same time|together|in one go|one after the other|last night|yesterday|earlier|tonight|this (?:morning|afternoon|evening))\b))`
	limitMod       = `(?:` + limitAdj + `|\d+[ -]?(?:hours?|hrs?|h|days?)\b|\d+(?:\.\d+)? ?(?:mg|mcg|g|grams?|ml)?|mg|mcg|g|grams?|ml|` + pill + `|doses?|dosage)`
	limitNoun      = `(?:dose|doses|dosage|amount|quantit(?:y|ies)|volume|` + serving + `|limit|max(?:imum)?|allowance|intake|threshold|` + numberOf + `)\b(?! (?:temperature|temp|storage|heat|humidity|shelf|instructions?|directions?|info\w*|sections?|chart|table|guide|label|details?|with|again)\b)`
	overAdv        = `(?:(?:way|well|far|much|a bit|a little|slightly|just|probably|definitely|already|now|really) )*`
	over           = overAdv + `(?:over|above|beyond|past)`
	bePerson       = `(?:i'm|im|i am|i've been|ive been|i was|he's|hes|he is|he was|she's|shes|she is|she was|we're|we are|we were|they're|theyre|they are|they were)`
	overLimit      = `(?:exceeded|surpassed|overshot|passed|(?:took|taken|went|gone|used|` + gave + recipient + `) ` + over + `|` + bePerson + ` ` + over + `|did (?:i|we|he|she|they|someone|(?:my|his|her|their|the) \w+) (?:exceed|overshoot|pass|go ` + over + `))(?: (?:the|my|his|her|their|its|our|a))?(?: ` + limitMod + `){0,3} ` + limitNoun
	another        = `(?:another|a second|a 2nd|an additional|one more|1 more|an extra)`
	extraDoseNoun  = `(?:one|dose|` + pill + `|spoonful|teaspoon|sachet)`
	tookAnother    = `(?:` + notPassive + `\b` + ingested + particle + ` ` + another + `(?: ` + extraDoseNoun + `)?|` + notPassive + `\b` + ingestedFood + ` ` + another + ` ` + extraDoseNoun + `|` + gave + recipient + ` ` + another + `(?: ` + extraDoseNoun + `)?)\b(?! ` + notMedicine + `\b)`
	byMistake      = `(?:by (?:mistake|accident)|accident(?:al+y|ly)|mistakenly|in error|unintentionally|without thinking)`
	toSomeone      = `(?: to (?:him|her|them|(?:my|his|her|their|our|the) [\w']+(?: [\w']+)?))?`
	bigger         = `(?:higher|bigger|larger|stronger|greater|heavier|excessive|huge|massive|enormous|(?:overly|excessively|very|really|super|dangerously|extremely|unusually|abnormally) (?:high|big|large|strong|heavy))`
	tooBig         = `too (?:high|big|large|strong|great|heavy)`
	biggerDoseAny  = biggerDose(`(?:doses?|dosages?|amounts?|quantit(?:y|ies)|spoonfuls?|teaspoons?|tablespoons?)`) // TS BIGGER_DOSE
	biggerDoseFood = biggerDose(`(?:doses?|dosages?)`)
	ongoing        = `(?:been|keep|keeps|kept|` + bePerson + `|am i|are (?:we|they|you)|is (?:he|she|(?:my|his|her|their|the) [\w']+))`
	taking         = `(?:taking|using|swallowing|popping|giving` + recipient + `)`
	amountOf       = `(?:` + sizeAmount + `|` + vesselQuant + vessel + `(?: full)?|` + countedMeasure + `) ` + ofThing
	sizeExcess     = `(?:` + amountOf + `|` + sizeAmount + `(?! of\b)` + notMedAfter + `)`
	sizeExcessFood = `(?:` + amountOf + `|` + sizeAmount + ` than ` + thanWhat + thanLabel + `|` + sizeDose + `(?! of\b))`
	multiple       = `(?:twice|double|triple|thrice|quadruple|(?:two|three|four|five|ten|[2-9]|10) times|[2-9] ?x)`
	multipleAs     = `(?:as (?:much|many)(?: [\w'-]+){0,2}? as )?`
	multipleDose   = multiple + ` (?:as (?:much|many)` + moreDose + ` as (?:` + thanWhat + thanLabel + `|` + thanUsual + `|` + thanWhat + thanPerson + `)|what (?:i|he|she|we|they|you)(?:'m|'re|'s)? (?:(?:usually|normally|always|would) )?(?:take|takes|use|uses|should(?: have)? (?:take|taken|use|have)|(?:was|am|is|are|were) (?:supposed|told|meant) to (?:take|have|use)|need|needed|was prescribed|am prescribed)\b)`
	multipleOf     = `(?:` + multiple + ` ` + multipleAs + thanWhat + thanLabel + `(?: ` + ofThing + `|(?! of\b))|` + multipleDose + `)`
	plainAmount    = `(?:the |my |his |her |their |our )?(?:(?:usual|normal|regular) )?(?:amount|quantity|number)\b`
	labelTail      = ` (?:(?:printed |written |stated )?(?:on|in) (?:the|its|my|his|her|their) (?:label|pack|box|bottle|leaflet|insert|directions|instructions|prescription)|(?:that )?(?:the|its|my|his|her|their) (?:label|pack|box|bottle|leaflet|directions|instructions|prescription|doctor|doc|pharmacist) ` + labelVerb + `|` + labelVerb + `)\b`
	multipleOfAte  = `(?:` + multiple + ` ` + multipleAs + thanWhat + `(?:` + plainAmount + labelTail + `|(?!` + plainAmount + `)` + thanLabel + `(?: ` + ofThing + `|(?! of\b)))|` + multipleDose + `)`
	andAlso        = `,? (?:and|plus|as well as|along with|together with|&)(?: then| also)?`
	objectWord     = `(?!(?:i|he|she|we|they|you|it|me|him|them|us|my|his|her|their|our|your|the|a|an|this|that|these|those|took|take|takes|taking|taken|had|have|has|having|was|were|is|are|am|be|been|can|could|should|would|will|may|might|must|did|do|does|need|needs|needed|forgot|forget|forgets|missed|skipped|got|get|gets|felt|feel|feels|went|made|make|makes|then|now|so|but)\b)[\w'-]+`
	secondExcess   = `(?:` + tooOrSo + ` ` + tooMuchThing + `|` + tooMuch + ` (?:` + objectWord + ` )?(?:doses?|` + pill + `|spoonfuls?|teaspoons?|tablespoons?)\b|(?:` + countWord2Plus + `|(?:[2-9]|[1-9]\d+)(?:\.\d+)?|a (?:few|couple|lot|bunch|handful|load|ton|heap|fistful))(?: of)? (?:(?:the|my|his|her|their|our|these|those) )?(?!` + notAThing + `|` + foodPhraseWith + `)[a-z][\w'-]*(?=[,.?!;]|$| (?:and|but|so|then|last|today|tonight|yesterday|earlier|too|now|at once|together|i|he|she|we|they)\b)|(?:` + countWord2Plus + `|(?:[2-9]|[1-9]\d+)(?:\.\d+)?|a (?:few|couple|lot|bunch|handful|load|ton|heap|fistful)|all|the whole|the rest|` + sizeAmount + `)(?: of)? (?:(?:the|my|his|her|their|our|these|those) )?(?:` + objectWord + ` ){0,2}?` + medicineWord + `)`
	secondMedicine = `(?:(?:some|a few|more|extra|several)(?: of)? (?:(?:the|my|his|her|their|our|these|those) )?)?(?:` + objectWord + ` ){0,2}?` + medicineWord
	unsure         = `(?:(?:(?:do|did|does)(?:n'?t| not)|can'?t|cannot|can not|couldn'?t|could not) (?:know|remember|recall|tell|say|count|be sure)|(?:not|un) ?sure|not certain|uncertain|no (?:idea|clue)|lost (?:count|track)|forgot|who knows)`
	emptyContainer = `(?:half[- ])?empty (?:(?:` + objectWord + ` ){0,2}?(?:blisters?(?: packs?)?|pill ?box(?:es)?|pill ?cases?|strips?|sachets?|vials?)\b|(?:[\w'-]+ ){0,2}?(?:bottles?|packs?|packets?|box(?:es)?|containers?|jars?|tubs?|tubes?) of(?! (?:(?:the|my|his|her|some) )?(?:` + foodMod + ` )?` + adultFood + `\b)|(?:[\w'-]+ )?` + medicineWord + ` (?:bottles?|packs?|packets?|box(?:es)?|containers?|jars?|tubs?|tubes?)\b)`
	afterTaking    = `\b(?:after|since|from|following) (?:(?:accidentally|accidently|mistakenly) )?(?:taking|swallowing|using|popping|chewing|downing|ingesting|consuming|giving` + recipient + `)`
	didTake        = `\bdid (?:i|we|he|she|they|someone|somebody|(?:my|his|her|their|the) \w+) (?:take|swallow|use|eat|drink|have|give` + recipient + `)`
	excessTail     = `(?:(?:` + tooOrSo + `|` + tooMuch + `)` + notMedAfter + `|(?:(?:way|much|far|a bit|a lot|slightly) )?` + moreWord + moreNoun + ` than (?:` + thanWhat + thanLabel + `|(?:usual|normal|normally|usually)\b|` + thanWhat + thanPerson + `|` + thanMultiple + `)|` + biggerDoseAny + `|` + multipleOf + `|` + sizeExcess + `|` + repeated + `|(?:the |a |an |my |his |her |their )?(?:whole|entire|full|rest of the) (?:\w+ )?(?:` + container + `|` + doseForms + `)\b|(?:all|most) of (?:it|them|the \w+|my \w+))`
	notStorage     = `(?<!\b(?:temperature|temperatures|temp|heat|humidity|storage|room|car|weather|fridge|freezer|box|pack|bottle|label|it|that|this|which) )`
)

// foodPhrase is TS foodPhrase: up to two modifiers, then a food word that
// ends the phrase.
func foodPhrase(tail string) string {
	return `(?:` + foodPhraseMod + ` ){0,2}` + adultFood + `(?=[,.?!;:)]|-(?!\w)|$| ` + tail + `\b)`
}

// biggerDose is TS biggerDose: NOUN is the dose word.
func biggerDose(noun string) string {
	return `(?:(?:(?:a|an|the|my|his|her|their|our) )?(?:(?:much|way|far|a lot|a bit|a little|slightly|even|significantly|considerably|really|very) )?` + bigger + `(?:[ -][\w']+){0,2}|(?:(?:way|far|much|a bit|a little|slightly|really) )?` + tooBig + `(?: of)? an?|an? ` + tooBig + `) ` + noun + `\b|(?:a|an|the|my|his|her|their|our) ` + noun + ` (?:(?:that|which) (?:was|were|is|are|(?:may|might) (?:be|have been)) )?(?:(?:way|far|much|a bit|a little|slightly) )?(?:` + tooBig + `\b|(?:higher|bigger|larger|greater|stronger) than\b)`
}

/* ------------------------------------------------------- refusal lists */

var possibleOverdose = reList("POSSIBLE_OVERDOSE",
	notPassive+`\b`+ingested+particle+` `+excess,
	notPassive+`\b`+ingestedFood+particle+` (?!(?:`+intensifier+`,? ){0,3}(?:too|so) much\b|`+tooMuch+`)`+excess,
	notPassive+`\b`+ingestedFood+` `+tooMuch+` (?:\w+ )?(?:doses?|`+pill+`|medicines?|meds)\b`,
	`(?:`+notPassive+`\b`+ingestedFood+particle+`|\bfed`+recipient+`|\b(?:been|keep|keeps|kept|`+bePerson+`) (?:drinking|having|eating)|\b(?:put|poured|measured|squirted|added|mixed)(?: (?:in|out|up))?) (?:(?:`+intensifier+`|(?:too|so) much),? ){0,3}(?:too|so) much `+tooMuchThing,
	gave+recipient+` `+givenExcess,
	gave+recipient+` `+tooOrSo+notMedAfter+notChildFood,
	gave+recipient+` (?:the |an? |his |her |their )?(?:full )?(?:adult|grown[- ]?up)(?:'s|s'?)? (?:dose|dosage|amount|strength|tablets?|pills?|version|one|syrup|medicine)\b`,
	`\b(?:both|each|all) (?:gave|given|administered)`+recipient+` (?:(?:a |an |the |his |her |their |my |our )?(?:[\w']+ )?(?:dose|doses|medicine|medication|meds|pills?|tablets?|syrup|spoonful)\b|(?:it|them|one) to\b)`,
	`\b`+tooOrSo+notMedAfter+`(?: [\w']+){0,3}? (?:was|were|got|has been|have been|had been|may have been|might have been) (?:given|taken|swallowed|consumed|drunk|eaten|used|administered|ingested)\b`,
	`\b(?:`+tooMuch+`|(?:`+countWord2Plus+`|(?:[2-9]|[1-9]\d+)(?:\.\d+)?)`+notMedAfter+`|an? `+sizeIntens+sizeWord+`|`+multiple+` (?:the|my|his|her|their))(?: [\w']+){0,2}? (?:doses?|pills?|tablets?|capsules?|caplets?|spoonfuls?|teaspoons?|tablespoons?|ml|mg|sachets?|amounts?|quantit(?:y|ies))\b (?:was|were|got|has been|have been|had been|may have been|might have been) (?:given|taken|swallowed|administered)\b`,
	`\b`+another+`(?: `+extraDoseNoun+`)? (?:was|were|got|has been|had been|may have been|might have been) (?:given|taken|swallowed|administered)\b(?: [\w']+){0,3}? `+byMistake+`\b`,
	`\b`+byMistake+`,? (?:[\w']+ ){0,3}?`+another+`(?: `+extraDoseNoun+`)? (?:was|were|got|has been|had been|may have been|might have been) (?:given|taken|swallowed|administered)\b`,
	`\b(?:dose|doses|dosage|amount|quantity) (?:that |which )?(?:i|he|she|we|they|you|(?:my|his|her|their|the) [\w']+) (?:took|had|used|swallowed|drank|got|gave`+recipient+`|was given) (?:was|were|is|are|might have been|may have been|seems?|seemed) (?:(?:way|far|much|a bit|a little|probably|definitely) )?(?:too (?:high|big|large|much|strong|great)|more than|over|above|double|twice)\b`,
	tookVerb+`(?: `+takenThing+`)? (?:way|far|much|a lot|lots|loads|a bunch|so much|so many|many) more\b(?! than\b)`+notMedAfter,
	`\b(?:tablespoons?|tbsps?|tablespoonfuls?)\b(?: [\w']+){0,4}? instead of (?:a |an |one |the |his |her |my )?(?:teaspoons?|tsps?|teaspoonfuls?)\b`,
	`\b(?:is|was|are|were) (?:the|that|this|my|his|her) (?:dose|doses|dosage|amount|quantity) (?:that |which )?(?:i|he|she|we|they|you|(?:my|his|her|their|the) [\w']+) (?:took|had|used|swallowed|drank|got|gave`+recipient+`|was given) (?:(?:way|far|much|a bit|a little) )?too (?:high|big|large|much|strong|great)\b`,
	`(?:`+tookVerb+`|`+notPassive+`\b`+ingestedFood+particle+`) (?:all )?(?:what(?:ever)?|all that) (?:was|is|were|'s) left\b(?! of (?:the |my |his |her |their |our )?(?:`+foodMod+` )?`+adultFood+`\b)`,
	`\b(?:put|poured|measured|squirted|drew up|added|mixed|gave)(?: (?:in|out|up))? (?:(?:`+intensifier+`|(?:too|so) much),? ){0,3}(?:too|so) much (?:in|into|inside) (?:his|her|their|the|my|our|its) (?:[\w']+ )?(?:mouth|bottle|syringe|dropper|spoon|medicine cup|dosing cup)\b`,
	`\b(?:been|keep|keeps|kept|am|i'm|im|is|are|was|were|he's|hes|she's|shes) (?:doubling|tripling|quadrupling|double[- ]?dosing)\b`,
	`\b(?:went|gone) overboard\b`,
	`\boverus(?:ed|ing)\b`,
	tookVerb+` `+biggerDoseAny,
	notPassive+`\b`+ingestedFood+particle+` `+biggerDoseFood,
	notPassive+`\b`+ingested+particle+` `+sizeExcess,
	gave+recipientReq+` `+sizeExcess,
	`\b(?:was|were|been|got|get|gets) given `+sizeExcess,
	`(?:`+notPassive+`\b`+ingestedFood+particle+`|`+gave+`) `+sizeExcessFood,
	notPassive+`\b(?:drank|drunk|had|(?:ended|wound) up (?:having|drinking))`+particle+` `+multipleOf,
	notPassive+`\b(?:ate|eaten|(?:ended|wound) up eating)`+particle+` `+multipleOfAte,
	notPassive+`\b`+ingestedFood+particle+` (?:(?:`+intensifier+`|(?:too|so) much),? ){0,3}(?:too|so) (?:much|many)(?: [\w'-]+,?){0,3}?`+andAlso+` `+secondMedicine,
	notPassive+`\b(?:`+ingested+`|`+ingestedFood+`)`+particle+`(?: [\w'-]+,?){1,5}?`+andAlso+` `+secondExcess,
	`\b(?:binged|overindulged|loaded up)(?: (?:on|in|with))? (?:(?:the|my|his|her|their|some|all|of|these|those) ){0,3}(?:`+objectWord+` ){0,2}?`+medicineWord,
	`\b(?:`+unsure+`(?: (?:of|about|exactly|really))? how (?:many|much)(?: (?!`+notMedicine+`\b|`+foodPhraseWith+`)[\w'-]+){0,3}?|lost (?:count|track) of (?:(?:the|my|his|her|their|all) )?(?:[\w'-]+ ){0,2}?`+medicineWord+`(?: (?:that|which))?) (?:i|he|she|we|they|you|someone|(?:my|his|her|their|the|our) [\w'-]+)(?:'ve|'d|'s| have| has| had)?(?: (?:might|may|could|must) (?:have|'ve))?(?: (?:already|actually|really|just))? (?:took|taken|had|swallowed|drank|drunk|ate|eaten|used|consumed|popped|chewed|gave|given|got)\b(?! to (?:drink|eat)\b)`,
	`\b(?:`+ingested+`|`+ingestedFood+`|gave)\b(?: (?!`+notMedicine+`\b|`+foodPhraseWith+`)[\w'-]+){0,5}?,? (?:(?:and|but|so) )?(?:i'?m |i am |i )?`+unsure+`(?: (?:of|about|exactly))? how (?:many|much)\b(?! (?:to|i (?:can|should|could|may|might)|(?:[\w'-]+ )?(?:is|are|was|were) (?:left|in|still))\b)`,
	notStorage+`\b(?:exceeded|surpassed|overshot|went (?:beyond|above|past)|gone (?:beyond|above|past)|`+bePerson+` `+over+`) `+thanWhat+thanLabel+`(?! (?:temperature|temp|storage|heat|humidity|light|shelf|for (?:the )?(?:storage|temperature))\b)`,
	notPassive+`\b`+ingested+particle+` (?:most|nearly all|almost all|the majority|the bulk) of (?:it|them|these|those)\b`,
	`\b`+childS+`\b(?: [\w'-]+){0,8}? (?:after|since|from) (?:eating|swallowing|drinking|chewing|licking|sucking on|biting|getting into) `+childObject+`\b`+notChildFood,
	`\b`+childS+`\b(?: [\w'-]+){0,6}? (?:(?:an?|the|my|his|her|their|our) )?`+emptyContainer,
	`\b`+emptyContainer+`(?: [\w'-]+){0,6}? (?:(?:the|my|his|her|their|our|a) )?`+child+`\b`,
	`(?:\b`+ongoing+` `+taking+`|`+afterTaking+`|`+didTake+`)(?: (?:it|them|one|`+takenDose+`))? `+excessTail,
	tookVerb+`(?: `+takenThing+`)?`+toSomeone+` `+repeated,
	notPassive+`\b`+ingestedFood+` `+takenThing+` `+repeated,
	notIt+tookVerb+morePrefix+` `+moreWord+moreNoun+` than (?:`+thanWhat+thanLabel+`|`+thanUsual+`|`+thanWhat+thanPerson+`|`+thanMultiple+`|enough\b|once\b(?! (?:a|per|each|every) (?:day|night|week|morning|evening)\b| (?:daily|nightly|weekly)\b))`,
	notPassive+notIt+`\b`+ingestedFood+morePrefix+` `+moreWord+` than `+thanWhat+thanLabel,
	notPassive+notIt+`\b`+ingestedFood+morePrefix+` `+moreWord+moreDose+` than (?:`+thanWhat+thanLabel+`|`+thanUsual+`|`+thanWhat+thanPerson+`|`+thanMultiple+`)`,
	notStorage+`\b`+overLimit,
	didTake+`(?: (?:it|them|one|`+takenDose+`))? (?:`+tooOrSo+`|`+tooMuch+`|more than)`,
	notIt+`\b(?:exceeded|surpassed|overshot) (?:it|that|them)\b`,
	`(?:`+notPassive+`\b(?:`+ingested+`|`+ingestedFood+`)`+particle+`|`+gave+recipient+`) `+both,
	tookVerb+` `+bothThem,
	tookVerb+` both (?:[\w']+ ){0,3}?`+byMistake+`\b`,
	tookAnother+` (?:[\w']+ ){0,3}?`+byMistake+`\b`,
	`\b`+byMistake+`,? (?:[\w']+ ){0,3}?`+tookAnother,
	tookVerb+`(?: `+takenThing+`)?`+toSomeone+` again\b`,
	notPassive+`\b`+ingestedFood+` `+takenDose+` again\b`,
	`\b(?:chugged|gobbled|downed|guzzled|wolfed|necked|scoffed|devoured|knocked back|polished off)(?: down| back| off)? (?:it|them|all|everything)\b`,
	`\b(?:doubled|tripled|quadrupled|double[- ]?dosed|overdid|overdone|overdoing|od'?d|oded)\b`,
	`\b`+childS+` `+childGap+`(?:`+childAccess+`|got to|got (?:some|one|it|them))\b`,
	`\b`+childS+` `+childGap+childIngested+childParticle+` `+childObject+`\b`+notChildFood,
	`\b`+childS+` `+childGap+mouthVerb+` `+mouthObject+` (?:in|into|inside) (?:his|her|their|its|the|a|my)(?: `+child+`'?s)? mouth\b`,
	`(?<!\b(?:put|puts|putting|give|giving|place|placing|squirt|squirting|pour|pouring|drop|dropping|insert|inserting|get|getting|apply|spoon|feed|feeding)(?: (?:the|a|an|this|that|my|his|her|their|some|one|half(?: a| of the)?))? )\b(?:`+pill+`|caps|medicines?|medications?|meds|syrup|something|one|some|it|them)\b(?: [\w']+){0,4}? (?:in|into|inside) (?:the |my |our |his |her |their )?`+child+`'?s mouth\b`,
	`\b(?:overdos\w*|poison\w*|toxic\w*|lethal|fatal|deadly)\b`,
	`\b(?:can|could|will|would|might|may|does|did) (?:it|this|these|they|that|too much|an overdose) kill\b`,
	`\bkill (?:me|you|him|her|them|us|someone|somebody|a (?:person|child|kid|baby))\b`,
	`\b(?:die|dies|died|dying)\b`,
)

// refusals are checked in this order; the first matching reason wins.
var refusals = []struct {
	reason   RefusalReason
	patterns []*jsregex.Regexp
}{
	{RefusalPillIdentification, reList("REFUSALS.pill_identification",
		`\b`+looks+`\b.*\b`+pill+`\b`,
		`\bwhat(?:'s| is)? (?:this|that|these|the) `+pill+`\b`,
		`\bwhat `+pill+` (?:is|are) (?:this|that|these|it)\b`,
		`\b(?:identify|recogni[sz]e)\b.*\b`+pill+`\b`,
		`\bwhich (?:medicine|drug) is this\b`,
	)},
	{RefusalSpecialPopulation, reList("REFUSALS.special_population",
		`\bpregnan`,
		`\bbreast ?feed`,
		`\bnursing\b`,
		`\blactat`,
		`\b(?:child|children|kids?|baby|babies|infants?|toddlers?|newborns?|teens?|teenagers?)\b`,
		`\b(?:son|daughter|grand(?:son|daughter|child))\b`,
		`\b\d+ ?-?(?:years?|yrs?|months?|mos?) ?-?old\b`,
		`\b(?:elderly|seniors?|old people|older people)\b`,
		`\b(?:grand(?:ma|pa|mother|father|parents?)|lol[ao])\b`,
		`\bwhat age\b`,
		`\bage\b`,
		`\b(?:buntis|sanggol|anak|bata)\b`,
	)},
	{RefusalInteraction, reList("REFUSALS.interaction",
		`\binteract`,
		`\b(?:combine|combining|mix|mixing)\b`,
		`\btogether\b`,
		`\bat the same time\b`,
		`\b(?:alcohol|beer|wine|liquor|drinking)\b`,
		`\b(?:take|taking|use|using|have|drink)\b.*\b(?:with|and|plus|after|before)\b.*\b(?:other|another|ibuprofen|paracetamol|acetaminophen|aspirin|antibiotics?|medicines?|medications?|meds|drugs?|pills?|tablets?|vitamins?|supplements?|food|coffee|milk|juice)\b`,
		`\bwith (?:my )?(?:other|another) (?:medicines?|medications?|meds|drugs?|pills?)\b`,
	)},
	{RefusalStartStop, reList("REFUSALS.start_stop",
		`\b(?:stop|stopped|stopping|quit|discontinue|start|starting|switch|switching|skip|skipping|resume)\b`,
		`\b(?:keep|continue) (?:taking|using)\b`,
		`\bchange (?:to|from|my)\b`,
		`\bmissed (?:a )?dose\b`,
	)},
	{RefusalPersonalDose, reList("REFUSALS.personal_dose",
		`\bhow (?:many|much)\b`,
		`\bhow often should\b`,
		`\b\d+(?:\.\d+)? ?(?:kg|kgs|kilos?|kilograms?|lbs?|pounds)\b`,
		`\bweigh`,
		`\bshould (?:i|he|she|we|they) take\b`,
		`\b(?:dose|dosage) (?:for|should|do)\b`,
		`\bwhat dose\b`,
		`\b(?:double|extra|more) (?:dose|tablets?|pills?)\b`,
		`\boverdos`,
		`\btoo (?:much|many)\b`,
		`\b(?:maximum|max)\b`,
		`\bat once\b`,
		// "took" means a dose was taken, except "took a photo"
		`\btook (?!(?:a |an |another |the |this |my )?(?:photos?|pictures?|pics?|images?|shots?|snaps?)\b)`,
		`\bmore than (?:the label|the box|the pack|it says|directed|recommended|prescribed|printed|stated|written)`,
		`\bper (?:kg|kgs|kilos?|kilograms?|pounds?|lbs?)\b`,
		`\bmg ?\/ ?kg\b`,
		// "is 4 tablets a day okay?", "would 1000 mg be fine?"
		`\b`+count+` ?`+amountUnit+`\b.*\b(?:ok|okay|fine|alright|all right|enough|too|safe|good|normal)\b`,
		// bare counts: "is 3 a day ok?", "is 2 enough?", "what if my wife takes two?"
		`\b`+bareCount+` (?:a|per|each) (?:day|night|time)\b`,
		`\b`+bareCount+`\b.*\b(?:ok|okay|fine|alright|all right|enough|too)\b`,
		`\btakes? `+bareCount+`\b`,
		`\bdouble (?:up|it)\b`,
		// overdose without "took": "i swallowed 6", "i ate the whole pack"
		`\b(?:swallowed|ate|drank|had) (?:\d+|all|the whole|too)\b`,
		`\bwhole (?:pack|box|bottle|strip)\b`,
		`\b(?:taken|popped|downed|used|finished|swallowed|ate|drank|had) (?:like |about |around )?(?:`+bareCount+`|a bunch|a lot|lots|many|several|some|the (?:whole |entire )?(?:pack|box|bottle|strip))\b`,
		`\b(?:i've|i have|ive) (?:taken|had|used)\b`,
		// "3x a day?", "3/day?", "3 times daily", "3 daily?"
		`\b`+bareCount+` ?(?:x|times|/) ?(?:a |per )?(?:day|daily|night)\b`,
		`\b`+bareCount+` daily\b`,
		`\b(?:once|twice|thrice) (?:a|per) day\b.*\b(?:ok|okay|fine|enough|too|safe)\b`,
		`\bextra (?:one|dose|pill|tablet)\b`,
		`\b(?:triple|double) (?:up|it|the dose)\b`,
		`\bilang?\b`,
	)},
	{RefusalDiagnosis, reList("REFUSALS.diagnosis",
		`\bdo (?:i|you think i) have\b`,
		`\bdiagnos`,
		`\bsymptoms?\b`,
		`\bwhat(?:'s| is) wrong with\b`,
		`\b(?:cure|treat|heal|fix|work for|good for|help with|help my)\b.*\bmy\b`,
		`\bmy (?:fever|headache|pain|cough|cold|flu|rash|infection|stomach|tummy|throat|condition|illness|disease)\b`,
		`\bi (?:feel|felt|am feeling|have been feeling)\b`,
		`\bi (?:have|got) (?:a |an )?(?:fever|headache|pain|cough|cold|flu|rash|infection|diarrh\w*|sore)\b`,
		`\bam i (?:sick|ill)\b`,
	)},
	{RefusalPersonalSafety, reList("REFUSALS.personal_safety",
		`\bsafe\b`,
		`\b(?:dangerous|harmful|risky)\b`,
		`\ballerg`,
		`\bside effects?\b.*\b(?:i|me|my)\b`,
		`\b(?:i|me|my)\b.*\bside effects?\b`,
		// "can my husband take", "should she use", "can diabetics take"
		`\b(?:can|could|should|may|must) `+subject+` (?:still )?(?:take|use|have|drink|swallow|give)\b`,
		`\bshould i (?:be worried|worry)\b`,
		`\b(?:can|could|should|may) (?:it|this|these|they|i|we) be (?:taken|used|given)\b`,
		`\b(?:fine|ok|okay|alright|all right|good) (?:for me|for us|with my)\b`,
		`\b`+condition,
		`\b(?:is|are) (?:it|this|these|they) (?:ok|okay|alright|all right|fine) (?:for|to)\b`,
		`\bwill (?:it|this) (?:hurt|harm|affect) me\b`,
		`\bstill (?:take|use)\b`,
		// "is it suitable for me?", "would my mom be okay taking this?", "is this for my dad too?"
		`\bsuitable\b`,
		`\b(?:be )?(?:ok|okay|fine|alright) (?:taking|to take|using|for (?:him|her|them|my \w+))\b`,
		`\bfor my \w+\b`,
		// review round 3: "is it appropriate for me?", "is this meant for adults like me?"
		`\b(?:appropriate|right|meant|safe) for (?:me|us|him|her|them|someone|adults like me)\b`,
		`\blike me\b`,
		`\bpwede ba\b`,
	)},
}

/* --------------------------------------------------- the structural gate */

var (
	// consumer is who consumed it: someone other than the asker, or nobody named.
	consumer = `(?:he|she|they|we|you|someone|somebody|anyone|my \w+|his \w+|her \w+|their \w+|the \w+)`
	// consumedVerb is a past-tense consumption verb; photo and purchase verbs are not consumption.
	consumedVerb = `(?!(?:printed|photographed|scanned|checked|opened|bought|purchased|found|received|read|showed|shown|uploaded|sent|stored|kept|labeled|labelled|listed|marked|stamped|attached|included|supplied|manufactured|packed|packaged|registered|verified|expired|dated|needed|wanted|dropped|lost|threw|saw|got|left|placed|stated|said|mentioned|called|named|asked|answered|explained)\b)(?:\w+ed|took|ate|drank|downed|swallowed|had)`
	// consumedObject is what was consumed: a pronoun, "all", or a container or dosage form.
	consumedObject = `(?:it|them|all|everything|(?:all of |all the |half the |the rest of the |the whole |the entire |the |a |an |my |his |her |their )+(?:\w+ )?(?:lot|bottles?|packs?|box(?:es)?|strips?|blisters?|packets?|jars?|tubs?|sachets?|syrups?|tablets?|pills?|capsules?|caplets?|tabs|caps|doses?|medicines?|meds|liquid|suspension|drops|spoonfuls?|teaspoons?|contents))\b`
)

// quantityTokens: any question carrying a quantity, frequency or
// administration token refuses as personal_dose (review round 4).
var quantityTokens = reList("QUANTITY_TOKENS",
	`(?<![\w./-])(?!(?:19|20)\d\d\b)\d+(?:\.\d+)?(?![\w/-]|\.\d| ?(?:mg|mcg|[µμ]g|g|ml|iu|units?)\b| ?%)`,
	`\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|couple)\b`,
	`(?<!\b(?:this|that|which|the|each|any|every|no|some|other|first|last) )\bone\b`,
	`\ba few\b`,
	`\bhandfuls?\b`,
	`\bbunch\b`,
	`\b(?:a lot|lots|several|plenty|loads)\b`,
	`(?<!\b(?:tell (?:me|us)|say|explain|read) (?:a bit |a little |some )?)\bmore\b(?! (?:about|info|information|details?|clearly|slowly|simply|simple|loudly)\b)`,
	`\banother\b`,
	`\bextra\b(?! strength)`,
	`\bsecond\b(?! (?:line|word|page|side|part|paragraph|panel|row|sentence|item|name|photo|picture|image|label|half)\b)`,
	`(?<!\b(?:read|say|repeat that|explain|tell|speak|said|play|hear|listen)\b.*)\bagain\b`,
	`\bevery (?:\w+ )?(?:hours?|hrs?|day|night|morning|evening|meal)\b`,
	`\b(?:hourly|daily|nightly|weekly)\b`,
	`\b(?:mornings?|nights?|tonight|bedtime|evenings?|noon|midday|midnight)\b`,
	`\bin (?:a|one|the same) day\b`,
	`\b(?:a|per|each) (?:day|night|hour)\b`,
	`\b(?:once|twice|thrice)\b`,
	`(?<!\b(?:top|bottom|left|right|upper|lower|other|first|second|back|front) )\b(?:half|halves)\b(?! of the (?:label|pack|box|photo|picture|image|text|page))`,
	`\b(?:split|splits|splitting|crush|crushes|crushed|crushing|chew|chews|chewed|chewing|break|breaking)\b`,
	`\bcut(?:ting)?\b(?! off)`,
	`\b(?:doubl|tripl|quadrupl)(?:e|es|ed|ing)\b(?![ -]check)`,
	`\bi (?!(?:opened|bought|purchased|photographed|scanned|checked|found|received|got|have|see|saw|read|want|need|hold|held|keep|kept|lost|dropped|threw|open|am)\b)\w+(?: down| through| off)? (?:the |a |an |my |all |all of |half |half of )*(?:whole |entire |full |rest of the )?(?:bottle|pack|box|strip|blister|packet|jar|tub|sachets?)\b`,
	`(?:^|\b`+consumer+` )`+consumedVerb+`(?: down| through| off| back)? `+consumedObject,
	`\b\d+(?:\.\d+)? ?(?:x|tabs?|caps?|h|hrs?|pcs?)\b`,
	`(?<![\w-])x ?\d+\b`,
	`\bq ?\d+ ?(?:h|hrs?|hours?)\b`,
	`\b(?:bid|tid|qid|prn|qds|tds|qhs)\b`,
	`\bquarters?\b`,
	`\b(?:dissolv|sprinkl)\w*`,
	`\bopen\w*\b.*\b(?:capsules?|caps)\b|\b(?:capsules?|caps)\b.*\bopen\w*`,
	`\bempty stomach\b`,
	`\bwith (?:food|meals?|a meal|milk|water|juice)\b`,
	`\b(?:before|after) (?:eating|meals?|food|sleep\w*|bed|breakfast|lunch|dinner|supper)\b`,
	`\bfor how long\b`,
	`\bhow long (?:should|can|must|do|to)\b`,
	`\b(?:a|one|per|each|for a|whole|entire) (?:weeks?|months?|fortnights?)\b`,
	`\bcontinu\w*`,
	`\b(?:keep|kept|keeps) (?:going|on)\b|\bcarry on\b`,
	`\b(?:spoon\w*|teaspoon\w*|tablespoon\w*|tsp|tbsp|capful\w*|cupful\w*|dropper\w*)\b`,
	`\b(?:monthly|alternate|every other)\b`,
	`^\d+(?:\.\d+)? ?(?:ml|cc|mg|mcg|g)\W*$`,
)

var (
	// personalSubject: first person, third person or a caregiver's charge.
	personalSubject = re("PERSONAL_SUBJECT", `\b(?:i|me|my|myself|mine|im|ive|id|we|us|our|he|she|they|him|her|them|his|their|someone|somebody|kids?|child|baby|son|daughter)\b`)
	// suitability words refuse with a first-person subject even inside a label-reading form.
	suitability = re("SUITABILITY", `\b(?:works?|working|worked|good|better|best|bad|worse|safe|safer|appropriate|meant|suitable|helps?|need|needs|enough|handle)\b|\bright\b(?! (?:side|corner|edge|hand|part|panel|of)\b)`)
	// modalSubject: "should i", "can we", "do i".
	modalSubject = re("MODAL_SUBJECT", `\b(?:can|could|should|would|may|might|must|shall|do|did|will|am|is it ok if) (?:i|we)\b(?! (?:hear|see|read|listen|know what (?:it|the \w+) says)\b)`)
	// useVerb: a request form does not rescue these; only a label-reading form does.
	useVerb = re("USE_VERB", `\b(?:take|takes|taking|took|use|uses|using|drink|drinking|swallow|swallowing|eat|eating|give|giving|apply|applying)\b|\bhave (?:it|this|one|these|them|some)\b`)
)

// labelReading: explicit label-reading forms.
var labelReading = reList("LABEL_READING",
	`\bwhat (?:does|do|did|is|was)\b.*\b(?:say|says|said|mean|means|printed|written)\b`,
	`\b(?:can|could|would|will|please) (?:you )?read\b`,
	`\bread (?:me |out |aloud |back )?(?:the|this|that|what|it)\b`,
	`\b(?:printed|written) (?:on|in|about)\b`,
	`\baccording to the (?:label|pack|box|directions|instructions|leaflet)\b`,
)

// requestForms: request and photo forms that carry a first-person word but
// ask nothing about use.
var requestForms = reList("REQUEST_FORMS",
	`\b(?:tell|show|give) (?:me|us)\b`,
	`\b(?:can|could|may) (?:i|we) (?:hear|see|read|listen|know what (?:it|the \w+) says)\b`,
	`\bi (?:can't|cant|cannot|can not|couldn't|couldnt) (?:see|read|find|make out|hear)\b`,
	`\bi (?:took|sent|uploaded|scanned|have) (?:a|the|this|another|my) (?:photos?|pictures?|pics?|images?|scans?)\b`,
)

// doseTalk: talk of a dose or of changing one (review round 5 (a)).
var doseTalk = reList("DOSE_TALK",
	`\b(?:dose|doses|dosage|dosages|dosing|redos\w*|re-dos\w*|overdos\w*)\b(?! forms?\b)`,
	`\b(?:increas\w*|rais(?:e|es|ed|ing)|reduc\w*|repeated|repeating|repeats|retak\w*|retook|re-tak\w*|skip\w*|missed)\b`,
	`(?<!\b(?:you|please) )\brepeat\b(?! (?:that|this|what|it back|the (?:last|warnings?|directions|label|text|name|answer))\b)`,
	`\btop(?:s|ped|ping)? (?:it |them |me |him |her )?up\b`,
	`\b(?:lessen\w*|halv\w*|less|fewer|decreas\w*|cut (?:back|down))\b`,
	`\b(?:bigger|higher|stronger|lower|larger|smaller|weaker)\b(?! (?:half|part|side|corner|edge|line|section|panel|left|right|text|font|print|letters|photo|picture|image)\b)`,
	`(?<!\b(?:look|looks|looking|looked|pick|picked|show|shows|showed|come|comes|came|set|sum|speak|turn|turned|bring|open|opened|end|ended|it|them|that|this|pull|pulled|make|made|mix|mixed|mess|messed|zoom|zoomed|scroll|scrolled|line|lined|fill|filled|follow|followed|shake|shook|wake|woke|get|got|catch|hold|held|speed|back|move|moved|go|goes|went|scan|scanned) )\bup\b(?! to date\b)`,
)

// adviceRequest: asking for advice or what the assistant itself would do.
var adviceRequest = reList("ADVICE_REQUEST",
	`\b(?:is|are) (?:this|it|these|they) (?:\w+ )?for (?:me|us)\b`,
	`\b(?:recommend|advise|advice|suggest)\w*`,
	`\b(?:would|should|will|did|could) you (?:take|use|give|do|try|buy|choose|pick)\b`,
	`\bif you were (?:me|him|her|them|us)\b`,
	`\bought\b`,
	`\bstill (?:ok|okay|good|fine|safe|usable|alright|effective|work\w*)\b`,
)

var (
	// labelNoun: words that make a question about the pack, the photo or the registry.
	labelNoun = re("LABEL_NOUN", `\b(?:label|labels|pack|packs|box|text|printed|written|print|say|says|said|mean|means|meaning|photo|picture|image|font|letters|fda|registry|registered|registration|brand|name|generic|expiry|expir\w*|manufacturer|batch|lot)\b`)
	// timing: elliptical timing with no label noun.
	timing = re("TIMING", `\b(?:food|meals?|stomach|now|later|today|tomorrow|yesterday|right away|immediately|asap|overnight|soon)\b`)
	// anyUseVerb: a medicine-use verb outside a label-reading form.
	anyUseVerb = re("ANY_USE_VERB", `\b(?:take|takes|taking|took|use|uses|using|drink|drinks|drinking|swallow\w*|chew\w*|chug\w*|gulp\w*|eat|eats|eating|give|gives|giving|apply|applying)\b(?! (?:me|us)\b)|\bhave (?:it|this|one|these|them|some|more|another)\b`)
	// suitabilityWord: suitability, comparison and effect words.
	suitabilityWord = re("SUITABILITY_WORD", `\b(?:strong|stronger|effective|effectiveness|worth|works?|good|better|best|bad|worse|kick in|pets?|dogs?|cats?|animals?|driv\w*|machinery)\b`)
)

// suitabilityQuestion: yes/no suitability with no subject (review round 5 (d)).
var suitabilityQuestion = reList("SUITABILITY_QUESTION",
	`\b(?:will|would|does|do|did|is|are|was|can|could|should|might|may) (?:this|it|these|they|that)(?: (?:really|still|even|actually|definitely))? (?:work|works|help|helps|right|the right \w+|enough|ok|okay|fine|alright|safe|effective|good|strong enough|necessary|needed|too \w+)\b`,
	`\btoo \w+`,
	`^(?:(?:is|are) (?:it|this|that|they) )?(?:ok|okay|fine|alright|good|bad|safe|right|enough)\W*$`,
	`\b(?:is|are) (?:this|it|these|they|that) (?:\w+ )?for (?!what\b)\w+`,
)

func anyTest(ps []*jsregex.Regexp, in jsregex.Input) bool {
	for _, p := range ps {
		if p.TestInput(in) {
			return true
		}
	}
	return false
}

// structuralRefusal is the structural gate (review round 4), checked after
// the named refusal lists. It returns "" when it does not refuse.
func structuralRefusal(in jsregex.Input) RefusalReason {
	if anyTest(quantityTokens, in) {
		return RefusalPersonalDose
	}
	if anyTest(adviceRequest, in) {
		return RefusalPersonalSafety
	}
	isLabelReading := anyTest(labelReading, in)
	if !isLabelReading && anyTest(doseTalk, in) {
		return RefusalPersonalDose
	}
	if !labelNoun.TestInput(in) {
		if timing.TestInput(in) {
			return RefusalPersonalDose
		}
		if anyTest(suitabilityQuestion, in) || suitabilityWord.TestInput(in) {
			return RefusalPersonalSafety
		}
	}
	if !isLabelReading && anyUseVerb.TestInput(in) {
		return RefusalPersonalSafety
	}
	if !personalSubject.TestInput(in) {
		return ""
	}
	if suitability.TestInput(in) || modalSubject.TestInput(in) {
		return RefusalPersonalSafety
	}
	if isLabelReading {
		return ""
	}
	if !useVerb.TestInput(in) && anyTest(requestForms, in) {
		return ""
	}
	return RefusalPersonalSafety
}

// dosePerson is anyone a modal can be about (Task 5b).
var dosePerson = `(?:i|we|he|she|they|someone|somebody|anyone|everyone|people|adults?|patients?|(?:my|his|her|their|our|your|the|a|this|that) (?!(?:label|labels|pack|box|text|photo|picture|image|registry|fda|dose|dosage|medicine|tablets?|capsules?|pills?|syrup|bottle|warnings?|directions|instructions|strength|name|brand)\b)\w+)`

var modalPerson = reList("MODAL_PERSON",
	`\b(?:can|could|should|would|will|may|might|must|shall|do|does|did|is it (?:ok|okay|fine|alright|safe) (?:if|for)|ok (?:if|for)) `+dosePerson+`\b`,
	`\b`+dosePerson+` (?:can|could|should|would|will|may|might|must|shall|needs? to|ha(?:ve|s) to|ought to|(?:is|are|am) (?:supposed|allowed|meant) to|wants? to)\b`,
)

var extraDoseVerb = re("EXTRA_DOSE_VERB", `\b(?:inject\w*|administer\w*|consum\w*|bump\w*|redo\w*)\b`)

// modalDoseRefusal: a modal about any person plus dose or use talk refuses
// even inside a label-reading form (Task 5b).
func modalDoseRefusal(in jsregex.Input) RefusalReason {
	if !anyTest(modalPerson, in) {
		return ""
	}
	if anyTest(doseTalk, in) || anyUseVerb.TestInput(in) || extraDoseVerb.TestInput(in) {
		return RefusalPersonalDose
	}
	return ""
}

/* ---------------------------------------------- anchored allow templates */

const (
	ask     = `(?:please )?(?:(?:can|could|would|will) you (?:please )?)?`
	please  = `(?: please)?`
	pack    = `(?:label|labels|pack|packet|package|packaging|box|carton|bottle|blister|strip|sachet|leaflet|insert|package insert|tube|container|wrapper)`
	det     = `(?:the|this|that|my)`
	onPack  = `(?: (?:on|in|from) ` + det + ` ` + pack + `)?`
	here    = `(?: here| on it)?`
	aloud   = `(?: (?:out loud|aloud|to me|for me))?`
	simpler = `(?: (?:in (?:simpler|simple|plain|easier|easy|other|everyday) (?:words|terms|language|english)|more simply|simply))?`
	// region is a part of the pack: "the second line", "the lower half of the label".
	region = `(?:top|bottom|left|right|front|back|side|first|second|third|last|next|other|upper|lower|middle)(?: (?:half|part|side|line|panel|section|row|paragraph|word|bit|corner|edge))?(?: of ` + det + ` ` + pack + `)?`
	// section: printed sections that are explained rather than read out.
	section = `(?:warnings?|cautions?|precautions?|directions?(?: for use)?|instructions?|storage(?: instructions?| conditions?| directions?)?|label text)`
	// field: printed fields that are read out.
	field = `(?:brand(?: name)?|generic(?: name)?|name|product name|medicine name|drug name|full name|manufacturer|maker|distributor|importer|ingredients?|active ingredients?|inactive ingredients?|dosage form|form|expiry(?: date)?|expiration(?: date)?|exp date|best before(?: date)?|manufacturing date|date of manufacture|lot(?: number| no)?|batch(?: number| no)?|registration(?: number| no)?|fda registration(?: number| no)?|reg no|dose amount|dosage amount)`
	// topic: what "what does the label say about ..." may ask about.
	topic = `(?:(?:the |its )?(?:` + field + `|` + section + `|strength|dose|dosage|dosing|storage)|how (?:often )?to (?:take|use|store) (?:it|this|them)|storing it)`
	// phraseStop: words a printed phrase may not contain, quoted or not (review round 1).
	phraseStop = `(?:i|me|my|mine|myself|we|us|our|ours|you|your|yours|he|him|his|she|her|hers|they|them|their|theirs|it|its|this|that|these|those|someone|somebody|anyone|anybody|everyone|everybody|nobody|people|can|could|should|would|will|shall|may|might|must|do|does|did|is|are|am|was|were|be|been|being|have|has|had|(?:do|does|did|is|are|was|were|has|have|had|ca|can|could|would|should|must|need|wo|ai|might|sha)nt|if|when|whenever|whether|how|why|what|which|who|whom|whose|where|and|or|but|so|then|than|because|until|till|ok|okay|yes|no|not|safe|safer|safest|safely|unsafe|harm\w*|fake\w*|counterfeit\w*|genuine\w*|real|really|authentic\w*|legit\w*|same|identical|equivalent\w*|similar|substitut\w*|interchangeab\w*|cur(?:e|es|ed|ing)|need\w*|true|false|fine|good|bad|better|best|worse|worst|wrong|right|enough|effective\w*|work\w*|treat\w*|heal\w*|kill\w*|many|much|more|most|less|fewer|often|freely|unlimited|doctors?|physicians?|pets?|dogs?|cats?|pupp(?:y|ies)|animals?|give\w*|gave|take\w*|took|mean\w*)`
	// phraseCompound: hyphenated or dotted label terms accepted whole (review round 2).
	phraseCompound = `(?:non-drowsy|sugar-free|sugar-coated|film-coated|enteric-coated|(?:extended|sustained|delayed|modified|controlled|immediate)-release|e\.g|i\.e)`
	// phraseNumber: '.' and '-' only between digits ("0.5", "2-8"), then an optional "%".
	phraseNumber = `\d+(?:[.-]\d+)*%?`
	phraseWord   = `(?:` + phraseCompound + `|` + phraseNumber + `|(?!` + phraseStop + `\b)[a-z0-9]+)[.,]?`
	// maxPhraseChars is the longest printed phrase "what does ... mean" accepts.
	maxPhraseChars = `60`
	// phrase: 1 to 6 words and at most 60 characters, quoted or not.
	phrase      = `(?=[^"']{1,` + maxPhraseChars + `}(?:["']| mean\b))` + phraseWord + `(?: ` + phraseWord + `){0,5}`
	quoted      = `(?:"` + phrase + `"|'` + phrase + `')`
	unclear     = `(?:unclear|not clear|unreadable|not readable|hard to read|blurry|blurred|illegible|missing|cut off|uncertain)`
	parts       = `(?:parts?|fields?|bits?|sections?|words?|lines?|details?|things?)`
	couldNotYou = `(?:(?:couldn't|couldnt|could not|can't|cant|cannot|can not|didn't|didnt|did not|weren't|were not) you|(?:could|can|did|were) you not)`
	reg         = `(?:fda |ph fda |philippine fda )?(?:registry|register|database|fda|records?)`
	regNo       = `(?:dr-xy|drhr-|drp-|dr-)\d{1,10}`
	thing       = `(?:it|this|this medicine|the medicine|this product|the product|this drug|this one)`
)

var templates = []struct {
	intent AllowedIntent
	source string
}{
	// unclear_parts
	{IntentUnclearParts, `(?:which|what) ` + parts + ` (?:were|are|was|is) ` + unclear},
	{IntentUnclearParts, `(?:which|what) (?:` + parts + ` )?` + couldNotYou + ` (?:read|see|make out)`},
	{IntentUnclearParts, `what(?:'s| is| was| were| are) ` + unclear},
	{IntentUnclearParts, `(?:is|was|are|were) (?:any(?:thing| part| parts| of it)?|something|it|part of ` + det + ` ` + pack + `|(?:the|this) (?:text|label|pack|box|photo|picture|image|print|writing|scan)|the ` + region + `|the ` + field + `|the strength)(?: on ` + det + ` ` + pack + `)? (?:` + unclear + `|clear|readable|legible)`},
	{IntentUnclearParts, `(?:were|are) there any (?:` + unclear + ` ` + parts + `|` + parts + ` (?:that (?:were|are) )?` + unclear + `)`},
	{IntentUnclearParts, `how (?:clear|readable|legible) (?:is|was) (?:the (?:photo|picture|image|label|text|scan)|it)`},
	// registry
	{IntentRegistry, `what (?:did|does) the ` + reg + `(?: (?:check|search|lookup|result|record))? (?:say|show|find|return|report)(?: about ` + thing + `)?`},
	{IntentRegistry, `what did you find in the ` + reg},
	{IntentRegistry, `is ` + thing + ` (?:fda[- ])?(?:registered|listed)(?: (?:with|by|in|on) the ` + reg + `)?(?: now)?`},
	{IntentRegistry, `is ` + thing + ` (?:in|on|listed in|listed on|found in) the ` + reg},
	{IntentRegistry, `(?:was|is) ` + thing + ` (?:found|listed|verified|matched|registered) (?:in|by|on|with) the ` + reg},
	{IntentRegistry, `(?:did|does|could|can) (?:the ` + reg + `|you) (?:find|match|verify|list|have) (?:` + thing + `|a match)(?: in the ` + reg + `)?`},
	{IntentRegistry, ask + `(?:check the ` + reg + `|search the ` + reg + `|look (?:it|this|this medicine) up in the ` + reg + `|look up ` + thing + ` in the ` + reg + `)` + please},
	{IntentRegistry, `is (?:the registration number|the reg no|` + regNo + `) (?:registered|in the ` + reg + `)`},
	{IntentRegistry, `what (?:is|was) the (?:registry|fda|verification|match|registration) (?:result|status|outcome)`},
	// strength
	{IntentStrength, `what(?:'s| is) the strength(?: (?:printed|written|shown|stated))?(?: (?:of|for) (?:it|this|this medicine|each (?:tablet|capsule|caplet)))?` + onPack + here},
	{IntentStrength, `what strength is (?:it|this|this medicine|printed|written|shown|stated|on ` + det + ` ` + pack + `)` + onPack + here},
	{IntentStrength, `how strong is (?:it|this|this medicine|each (?:tablet|capsule|caplet))(?: per (?:tablet|capsule|caplet|ml))? according to ` + det + ` ` + pack},
	{IntentStrength, `is (?:it|this|the strength) \d+(?:\.\d+)? ?(?:mg|mcg|g|ml|iu|%)`},
	{IntentStrength, ask + `(?:tell me|read(?: me)?|say) the strength` + onPack + please},
	// explain_text
	{IntentExplainText, `what does (?:this|the|that) (?:warning|caution|precaution|direction|instruction|word|phrase|sentence|line|term|abbreviation|symbol|sign|icon|statement|note|part|section|bit|text|storage instruction) mean` + simpler},
	{IntentExplainText, `what do (?:these|the|those) (?:warnings|cautions|precautions|directions|instructions|words|phrases|sentences|lines|terms|abbreviations|symbols|signs|icons|statements|notes) mean` + simpler},
	{IntentExplainText, `what does (?:it|that|this) mean` + simpler},
	{IntentExplainText, `what does (?:the (?:word|term|phrase|abbreviation|sentence|line|warning|instruction|direction) )?` + quoted + ` mean` + simpler},
	{IntentExplainText, `what does (?:the (?:word|term|phrase|abbreviation) )?` + phrase + ` mean` + simpler},
	{IntentExplainText, ask + `(?:explain|simplify|clarify|rephrase|paraphrase|summari[sz]e) (?:the |this |that |these |those )?` + section + `(?: on ` + det + ` ` + pack + `)?` + simpler + please},
	{IntentExplainText, ask + `explain (?:it|that|this|what (?:it|that|this|` + det + ` ` + pack + `) (?:says|means))` + simpler + please},
	{IntentExplainText, ask + `(?:say|put|explain|word) (?:it|that|this) (?:in (?:simpler|simple|plain|easier|easy|other|everyday) (?:words|terms|language|english)|more simply|simply)` + please},
	{IntentExplainText, `what (?:are|were) the ` + section + onPack},
	{IntentExplainText, `what (?:do|does) the ` + section + ` say`},
	{IntentExplainText, `how (?:should|must|can) (?:it|this|this medicine|these|the (?:tablets|capsules|medicine|bottle|pack)) be (?:stored|kept)`},
	{IntentExplainText, `how (?:is|are) (?:it|this|this medicine|these) (?:stored|kept)`},
	{IntentExplainText, `how (?:do you |to |should you )?store (?:it|this|this medicine|them)`},
	{IntentExplainText, `tell me (?:more )?about the ` + section},
	{IntentExplainText, ask + `read (?:me |out )?the ` + section + aloud + `(?: again)?` + please},
	// read_label
	{IntentReadLabel, ask + `read (?:me |out |aloud |back )?(?:(?:` + det + ` )?` + pack + `|it|this|that|everything|all of it|(?:the )?(?:whole|entire|full) (?:` + pack + `|thing|text)|what (?:it|` + det + ` ` + pack + `) says)` + aloud + `(?: again)?` + please},
	{IntentReadLabel, ask + `read (?:me )?the ` + region + aloud + please},
	{IntentReadLabel, ask + `(?:read|tell me|say) (?:me )?the ` + field + onPack + please},
	{IntentReadLabel, `what does (?:` + det + ` )?` + pack + ` (?:say|read|show|state)(?: about ` + topic + `)?`},
	{IntentReadLabel, `what (?:does|do) it say(?: on ` + det + ` ` + pack + `)?(?: about ` + topic + `)?`},
	{IntentReadLabel, `what(?:'s| is) (?:printed|written|shown) (?:on|in) ` + det + ` ` + pack},
	{IntentReadLabel, `what (?:does|do) (?:the )?(?:text|words?|writing|print|wording|small print|fine print)(?: on ` + det + ` ` + pack + `)? say`},
	{IntentReadLabel, `what does the ` + region + ` say`},
	{IntentReadLabel, ask + `tell me what (?:it|` + det + ` ` + pack + `) says`},
	{IntentReadLabel, `what(?:'s| is| are) (?:the |its )?` + field + `(?: (?:printed|written|shown|listed|stated))?` + onPack + here},
	{IntentReadLabel, `what ` + field + ` is (?:printed|written|shown|listed|stated|on ` + det + ` ` + pack + `)(?: (?:on|in) ` + det + ` ` + pack + `)?` + here},
	{IntentReadLabel, `which (?:one|part|line|word) is the ` + field},
	{IntentReadLabel, `where(?:'s| is) the ` + field + `(?: (?:printed|written|shown))?` + onPack},
	{IntentReadLabel, `who (?:makes|made|manufactures|manufactured|produces|produced|distributes|distributed|markets|marketed) ` + thing},
	{IntentReadLabel, `when does (?:it|this|this medicine|the medicine|` + det + ` pack) expire`},
	// other_label: repeat the last answer
	{IntentOtherLabel, ask + `(?:repeat (?:that|this|it|the answer|the last (?:part|answer|sentence|bit|line))|say (?:that|it|this) again)(?: (?:more )?(?:slowly|slower|louder))?` + please},
	{IntentOtherLabel, `(?:pardon|say again|what did you say)`},
}

type allowTemplate struct {
	intent AllowedIntent
	re     *jsregex.Regexp
}

// allowTemplates are the templates anchored to the whole question.
var allowTemplates = func() []allowTemplate {
	out := make([]allowTemplate, len(templates))
	for i, t := range templates {
		out[i] = allowTemplate{t.intent, re("TEMPLATES["+strconv.Itoa(i)+"] "+string(t.intent), `^(?:`+t.source+`)$`)}
	}
	return out
}()

// notPrintableASCII: English only, any character outside printable ASCII
// left after normalisation.
var notPrintableASCII = re("NOT_PRINTABLE_ASCII", `[^\x20-\x7e]`)

/* --------------------------------------------------------- normalisation */

// isInvisible is TS INVISIBLE, /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu.
// Default_Ignorable_Code_Point is derived (UAX #44) as
// Other_Default_Ignorable_Code_Point + Cf + Variation_Selector - White_Space
// - FFF9..FFFB - 13430..1343F - Prepended_Concatenation_Mark; every code
// point the subtraction removes is Cf, so the union with \p{Cf} is
// Cf + Other_Default_Ignorable_Code_Point + Variation_Selector. Checked per
// code point against V8 by TestJSUnicodeTables.
func isInvisible(r rune) bool {
	return unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Other_Default_Ignorable_Code_Point, r) ||
		unicode.Is(unicode.Variation_Selector, r)
}

// jsTrim is String.prototype.trim: JS WhiteSpace and LineTerminator.
func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// normalise is TS normalise:
//
//	q.normalize('NFKC')
//	 .replace(INVISIBLE, '')            removed, not replaced by a space
//	 .toLowerCase()                     full mapping (x/text cases, Und)
//	 .replace(/[‘’‛′`]/g, "'")
//	 .replace(/[“”„‟″]/g, '"')
//	 .replace(/\s+/g, ' ')              JS \s, not unicode.IsSpace
//	 .trim()
//
// then strips trailing ' ', '?', '.', '!', ',', ';', ':' with a linear scan.
func normalise(q string) string {
	t := norm.NFKC.String(q)
	t = strings.Map(func(r rune) rune {
		if isInvisible(r) {
			return -1
		}
		return r
	}, t)
	t = cases.Lower(language.Und).String(t)
	var b strings.Builder
	b.Grow(len(t))
	inSpace := false
	for _, r := range t {
		if isJSSpace(r) {
			if !inSpace {
				b.WriteByte(' ')
			}
			inSpace = true
			continue
		}
		inSpace = false
		switch r {
		case '‘', '’', '‛', '′', '`':
			r = '\''
		case '“', '”', '„', '‟', '″':
			r = '"'
		}
		b.WriteRune(r)
	}
	t = strings.Trim(b.String(), " ")
	return strings.TrimRight(t, " ?.!,;:")
}

/* ------------------------------------------------------------ the gate */

func refusalReason(in jsregex.Input) RefusalReason {
	if anyTest(possibleOverdose, in) {
		return RefusalPossibleOverdose
	}
	for _, r := range refusals {
		if anyTest(r.patterns, in) {
			return r.reason
		}
	}
	if r := structuralRefusal(in); r != "" {
		return r
	}
	return modalDoseRefusal(in)
}

// ClassifyQuestion is the default-deny safety gate: refused unless the whole
// normalised question matches an allow template and no refusal pattern.
func ClassifyQuestion(q string) QuestionClass {
	text := normalise(q)
	n := jsregex.Len(text)
	if n == 0 || n > maxQuestionChars {
		return refused(RefusalOutsideLabel)
	}
	in := jsregex.NewInput(text)
	if r := refusalReason(in); r != "" {
		return refused(r)
	}
	// after the refusals, so "my baby swallowed some" followed by an emoji
	// or an em dash still gets the emergency text
	if notPrintableASCII.TestInput(in) {
		return refused(RefusalOutsideLabel)
	}
	for _, t := range allowTemplates {
		if t.re.TestInput(in) {
			return QuestionClass{Allowed: true, Intent: t.intent}
		}
	}
	return refused(RefusalOutsideLabel)
}

/* ------------------------------------------------- explain_text grounding */

var (
	explainPhrase = re("EXPLAIN_PHRASE", `^what (?:does|do) (?:the (?:word|term|phrase|abbreviation|sentence|line|warning|instruction|direction) )?(?:"([^"]*)"|'([^']*)'|(.+?)) mean`+simpler+`$`)
	// deictic: "what does this warning mean" points to a section, not a printed phrase.
	deictic   = re("DEICTIC", `^(?:it|this|that|these|those|(?:this|that|these|those|the) (?:warning|caution|precaution|direction|instruction|word|phrase|sentence|line|term|abbreviation|symbol|sign|icon|statement|note|part|section|bit|text|storage instruction)s?)$`)
	anyQuoted = re("ANY_QUOTED", `"([^"]+)"`)
)

// ExtractExplainPhrase is the printed phrase an explain_text question asks
// to have explained, normalised like the classifier's input, or nil when
// the question names no printed phrase (Task 7 controller ruling). Quoted
// or unquoted; a quoted phrase anywhere in the question also counts.
func ExtractExplainPhrase(question string) *string {
	in := jsregex.NewInput(normalise(question))
	if m := explainPhrase.ExecInput(in); m != nil {
		if s, ok := m.Group(1); ok {
			s = jsTrim(s)
			return &s
		}
		if s, ok := m.Group(2); ok {
			s = jsTrim(s)
			return &s
		}
		bare, _ := m.Group(3)
		bare = jsTrim(bare)
		if deictic.Test(bare) {
			return nil
		}
		return &bare
	}
	if m := anyQuoted.ExecInput(in); m != nil {
		if s, ok := m.Group(1); ok {
			s = jsTrim(s)
			return &s
		}
	}
	return nil
}

/* ------------------------------------------------------- asked fields */

// askedFieldRows: the first matching row wins (final review I3).
var askedFieldRows = []struct {
	re   *jsregex.Regexp
	keys []contracts.FieldKey
}{
	// printed things the reader does not transcribe into any field
	{re("ASKED_FIELDS[0]", `\b(?:manufactur(?:ing|ed) date|date of manufacture|mfg date|inactive ingredients?)\b`), []contracts.FieldKey{}},
	{re("ASKED_FIELDS[1]", `\b(?:stor(?:e|es|ed|ing|age)|kept)\b`), []contracts.FieldKey{contracts.FieldStorage}},
	{re("ASKED_FIELDS[2]", `\b(?:expir\w*|exp date|best before|use by)\b`), []contracts.FieldKey{contracts.FieldExpiryDate}},
	{re("ASKED_FIELDS[3]", `\b(?:lot|batch)\b`), []contracts.FieldKey{contracts.FieldBatchNumber}},
	{re("ASKED_FIELDS[4]", `\b(?:registration|reg no)\b`), []contracts.FieldKey{contracts.FieldRegistrationNumber}},
	{re("ASKED_FIELDS[5]", `\b(?:prescription|rx|otc|over the counter)\b`), []contracts.FieldKey{contracts.FieldRxOrOtc}},
	{re("ASKED_FIELDS[6]", `\b(?:manufactur\w*|maker|makes|made|produc(?:es|ed)|distribut\w*|import\w*|market(?:s|ed))\b`), []contracts.FieldKey{contracts.FieldManufacturer}},
	{re("ASKED_FIELDS[7]", `\b(?:dosage )?form\b`), []contracts.FieldKey{contracts.FieldDosageForm}},
	{re("ASKED_FIELDS[8]", `\bbrand\b`), []contracts.FieldKey{contracts.FieldBrandName}},
	{re("ASKED_FIELDS[9]", `\bgeneric\b`), []contracts.FieldKey{contracts.FieldGenericNames}},
	{re("ASKED_FIELDS[10]", `\b(?:active )?ingredients?\b`), []contracts.FieldKey{contracts.FieldGenericNames, contracts.FieldStrength}},
	{re("ASKED_FIELDS[11]", `\bstrength\b`), []contracts.FieldKey{contracts.FieldStrength}},
	{re("ASKED_FIELDS[12]", `\b(?:warnings?|cautions?|precautions?)\b`), []contracts.FieldKey{contracts.FieldWarnings}},
	{re("ASKED_FIELDS[13]", `\b(?:directions?|instructions?|dose|doses|dosage|dosing|how (?:often )?to (?:take|use))\b`), []contracts.FieldKey{contracts.FieldDirections}},
	{re("ASKED_FIELDS[14]", `\bname\b`), []contracts.FieldKey{contracts.FieldBrandName, contracts.FieldGenericNames}},
}

// AskedFields is the label fields an allowed question names, in reading
// order, or nil when it names none (read the whole label, or "what does
// this mean?"). An empty, non-nil list means it names something the reader
// never transcribes, such as a manufacturing date: that is answered as not
// read, never from another field. The result is a fresh slice.
func AskedFields(question string) []contracts.FieldKey {
	in := jsregex.NewInput(normalise(question))
	for _, row := range askedFieldRows {
		if row.re.TestInput(in) {
			return append([]contracts.FieldKey{}, row.keys...)
		}
	}
	return nil
}
