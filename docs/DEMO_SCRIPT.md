# MediLens AI — Demo Script (≤ 3:00)

Recorded on the owner's Android phone (screen recording with TalkBack audio, or a second camera
filming the phone). Total target: **2:50**, leaving 10 seconds of margin under the 3-minute limit.

Rules for the video:

- Live segments use a **real medicine pack the owner owns**, scanned in live mode. Say it is live.
- Demo-mode segments show the **DEMO DATA** banner on screen and are described as simulated
  scenarios with fictional products. Never present a demo result as a real verification.
- Do not show, mention or imply Meta glasses support. Glasses appear only as "roadmap" on the
  closing card, if at all.
- Only show the live segment if the 20-pack eval met the bar (zero confidently-wrong strengths or
  expiry dates); if it did not, state that caveat on screen.

| Time | Segment | On screen | Voice-over (approximate) |
|---|---|---|---|
| 0:00–0:15 | Problem | Close-up of tiny print on a medicine box | "Medicine labels are printed for perfect eyesight. For people with low vision and many older adults, reading the strength or the expiry date is guesswork." |
| 0:15–0:25 | What it is | Home screen, TalkBack focus on Scan medicine | "MediLens AI reads the label aloud, checks it against the Philippine FDA registry, and tells you when it isn't sure. It's a label reader, not medical advice." |
| 0:25–1:10 | Live scan (real pack) | Camera, torch, 2 photos, preview, Analyze, analyzing screen announcing the real stages ("Reading the label.", "Checking the registry."), result with status badge, spoken summary playing; pause and repeat | "This is live. Meta Muse Spark transcribes the label, field by field, with how legible each field is. Our own deterministic code, not the model, compares it with the FDA registry." |
| 1:10–1:25 | Evidence | Label fields screen (legibility chips) then Verification and sources (registry record, link, checked time, "Registration certificate valid until") | "Every field shows what was read and how clearly. The registry date is the registration certificate, never the medicine's expiry." |
| 1:25–1:45 | Ask | Ask screen, tap preset "Explain the directions in simpler words.", answer spoken | "You can ask about what's printed, using these preset questions." |
| 1:45–2:00 | Refusal (demo s7) | Demo mode, DEMO DATA banner, s7, Ask a question, tap the "How many should I take for my headache?" button, refusal shown and spoken | "Simulated scenario. Questions about personal dosing are refused and sent to a pharmacist." |
| 2:00–2:25 | Honest uncertainty (demo s4, s5, s2) | DEMO DATA: s4 "Does not match registry" with "500 mg on label, 250 mg Tablet in registry"; s5 "No registry match" with "does not mean the product is fake"; s2 "Label unreadable" with retake prompt | "When the label and registry disagree, it warns you. When there's no match, it says so without calling anything fake. When the photo is bad, it asks for another." |
| 2:25–2:40 | Accessibility | Settings: Extra large text, High contrast, speech rate; TalkBack announcing "Verification: …" | "Built for TalkBack, large text, high contrast and adjustable speech." |
| 2:40–2:50 | Close | Title card: MediLens AI, Meta Muse Spark, PH FDA registry; "Roadmap: Meta glasses, spoken questions, Filipino" | "MediLens AI. See the label. Hear the information. Understand with confidence." |

Before recording: start the hosted (or LAN) Go API in live mode (`MODEL_PROVIDER=muse_spark`,
`REFERENCE_PROVIDER=ph_fda`, `MODEL_API_KEY`) with the spend cap set, confirm
`GET /api/v1/config/capabilities` reports `modelProvider: "muse_spark"` and
`modelId: "muse-spark-1.3"`, run each demo scenario once, and rehearse with a timer.

Optional extra (only if time allows, never in place of the phone segments): show an MCP client
calling `extract_medication_label` with `scenario_id: "s1-clear"` and `explain_verified_label`
refusing a dosing question, on DEMO DATA, and say so. Do not present an emulator as a phone or as
glasses.
