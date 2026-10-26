# MediLens AI: Decision Memo

**Date:** 2026-10-27, Manila time. **Prepared by:** the synthesis judge. **Basis:** five research topics with adversarial verdicts, plus my own checks of the primary sources on 2026-10-27.

**How to read the status tags**
- **[VERIFIED]**: a load-bearing claim that survived the adversarial check (using the checker's corrected wording where it gave one), or a fact the checker read directly on the primary source.
- **[VERIFIED\*]**: I confirmed it myself on the primary source on 2026-10-27. It has not been adversarially tested.
- **[UNVERIFIED]**: comes from a source but was not adversarially checked, comes only from a secondary source, or is an inference or estimate.
- **[REFUTED]**: failed the check. Do not rely on it.
- Lines starting with **Decision:** are recommendations, not facts.

## Bottom line

1. **The event.** It is the **Meta Global AI Developer Hackathon**, run by Meta and Cerebral Valley. It is already under way. Submissions close **Nov 4, 2026 at 9:00 PM ET, which is Nov 5 at 10:00 AM in Manila** (about 9 days from now). Only applicants who were accepted by Oct 26 can take part. [VERIFIED] If the owner was not accepted, MediLens cannot enter this event.
2. **Decision: the MVP.**
   - The app is built with Expo SDK 58 and developed in Expo Go.
   - The phone sends a photo to the Node/Express backend.
   - The backend sends the photo to Meta Model API `muse-spark-1.3` (Standard mode, which does not train on our data) and gets back structured data checked against a schema.
   - The backend checks the result against the Philippine FDA (PH FDA) registry.
   - The app reads the result aloud on the device with `expo-speech`.
   - The MVP uses no glasses, no Llama and no custom native code.
3. **Decision: stretch goals, in this order.**
   - Spoken questions in English, Tagalog or a mix, using Muse Voice Transcribe.
   - Reading several sides of a box in one request.
   - Cropping the label area with SAM 3.1.
   - Glasses support (the Wearables Device Access Toolkit) stays on the roadmap only.
4. **Do today.**
   - Confirm acceptance and eligibility.
   - Create a Meta Model API account. It needs a payment method on file.
   - Claim the $150 credits. They take up to 2 business days to arrive.
   - Run one real medicine box through `muse-spark-1.3`.
   - Run `node -v` and confirm Node is 24.3 or newer.
   - Start a new public repo.

---

## 1. Hackathon

### 1.1 Which event matches
- **It is the Meta Global AI Developer Hackathon.** Meta announced it at Connect 2026 (recap dated 2026-09-24) as "a global virtual hackathon" where you "Build on Meta Model API, Muse Code or our open-weights models". It runs 10 days, has an indie track and a startup track, and has a $1M cash prize pool. Sources: [Meta recap](https://developers.meta.com/blog/meta-connect-recap/), [Meta event page](https://dev.meta.ai/events/global-hackathon). [VERIFIED]
- **Meta and Cerebral Valley host it together.** Meta's page is a separate page, not a copy. It holds the timeline and eligibility, and its "Apply now" button goes to the [Cerebral Valley page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon). That page's web address ends in `meta-ai-developer-hackathon`, which is the name the owner uses. [VERIFIED, corrected]
- **No other Meta-run hackathon for late 2026 turned up.** The Llama hackathons were in 2024 and 2025. The OpenEnv hackathon in India (April 2026) is over. The Wearables FAQ only says Meta is "exploring" hackathons ([FAQ](https://developers.meta.com/wearables/faq)). [UNVERIFIED: based on finding nothing]
- **The binding rules are published.** They are titled "Hackathon Terms & Conditions ("Official Rules") and Event Waiver" and sit on the [waiver page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver). The event page still says "Official Rules will be published before the Hackathon begins", but that note is out of date. [VERIFIED; VERIFIED\*]

### 1.2 Dates
Meta says "Dates may be subject to change at Meta's sole discretion". [VERIFIED]

| Milestone | US Eastern | Manila (UTC+8) | Status |
|---|---|---|---|
| Applications opened | Oct 13, 9:00 AM | Oct 13, 9:00 PM | [VERIFIED\*] |
| Applications closed (earlier if 20,000 places filled) | Oct 25, 11:59 PM | Oct 26, 11:59 AM | [VERIFIED] |
| Acceptance emails sent by | Oct 26, 9:00 AM | Oct 26, 9:00 PM | [VERIFIED] |
| Live workshops and Discord office hours | Oct 27 – Nov 4 | | [VERIFIED\*] |
| **Project submissions due; also the last day to claim credits** | **Nov 4, 9:00 PM (EST)** | **Nov 5, 10:00 AM** | [VERIFIED]; [VERIFIED\*] |
| Judging | Nov 4–8 | | [VERIFIED] |
| Closing ceremony, live finals, winners | Nov 9 (start time not published) | | [VERIFIED] |

### 1.3 Eligibility (from the Official Rules)
- **Only accepted applicants can take part.** "All individuals interested in attending ... must complete, submit an application through the official application process, and be accepted." Places were capped at 20,000, and the application deadline has passed. [VERIFIED]
- **Age.** Participants must be "at least 18 years old ... and the age of majority in the applicant's jurisdiction of residence." [VERIFIED; VERIFIED\*]
- **Country.** The Philippines is not excluded. The excluded places are:
  - Belarus, China, Russia, Ukraine and Syria;
  - the Crimea, Donetsk and Luhansk regions;
  - Cuba, North Korea and Iran;
  - anyone targeted by US, EU, UN or UK sanctions;
  - anywhere "local law prohibits participation or the receipt of an award."

  This clause is in the binding rules themselves. [VERIFIED; VERIFIED\*]
- **People who are excluded.**
  - "Government-affiliated individuals" cannot take part. The ban also covers their immediate family (including in-laws) and anyone living in the same household.
  - Employees, contractors and interns of Meta and Cerebral Valley are also excluded.
  - The rules do not define "government-affiliated". A Philippine government employee should assume they are ineligible until the organizers confirm otherwise in writing. [VERIFIED]
- **Employer rules.** To claim the credits, you must confirm you comply with "laws, rules and regulations applicable to any current employer governing the acceptance of things of value." This is §6.2 of the Credit Terms PDF, which is linked from the Official Rules. [VERIFIED\*]
- **Teams and tracks.**
  - The indie track allows teams of up to 4.
  - One team member, the Representative, must meet the individual eligibility rules. They submit the project and list every member.
  - The rules say "a participant may apply for one (1) track only, and a project submission may be entered in one (1) track only." [VERIFIED; VERIFIED\*]
  - The rules imply that every teammate must have been accepted individually, but they do not say so outright. [UNVERIFIED]
- **The two tracks.** [VERIFIED\*]
  - Indie: "For individual builders and students. Judged on creativity, technical ambition, and whether it works."
  - Startup: "For teams and founders building a real product. Judged on technical execution and whether it holds up in production."

### 1.4 Judging (from the Official Rules) [VERIFIED; VERIFIED\*]
- **Impact, 30%.** "Who benefits, how much it matters, whether it could become something people use, and whether it fits one of the problem statements."
- **Use of Meta AI Tooling, 25%.** "How creatively the team used Meta's AI tooling, whether they went beyond a basic integration, and whether they surfaced unexpected capabilities."
- **Technical Depth & Execution, 20%.**
- **Demo, 25%.** "A working, impressive demo, whether the product holds up live, and the quality of the demo video."
- The judges' decisions are final. These criteria apply to projects, not applications.
- **The only "problem statements" I found are the two themes.** [VERIFIED\*] Whether they are exactly what the rubric means is [UNVERIFIED].
  - "Build for Your World. Bring Meta's models into your domain. Solve a problem you know firsthand..." MediLens fits this one.
  - "Push the Frontier..."

### 1.5 Meta tools, credits, submission, ownership and prizes
- **Using Meta's tools is expected, but not formally required.**
  - The Official Rules say "Participants build with Meta AI products, including Muse Spark, Glimmer, SAM 3, and any other Meta AI products identified on the Event page." [VERIFIED; VERIFIED\*]
  - The event page lists the Muse Spark models, Muse Wonder, Muse Image and SAM 3.1 through Meta Model API, plus Meta's open-weight models and the Muse Code coding agent. [VERIFIED]
  - Calling these tools "required" is [REFUTED]: there is no must-use clause.
  - The Credit Terms say "Participants may build with Meta's open-weight models without a Meta Model API account." [VERIFIED\*]
  - Neither page mentions Llama, the Wearables toolkit or any hardware. [VERIFIED]
- **Credits.** Each accepted participant can claim **USD $150** in Meta Model API credits. Source: Credit Terms §3.1, the PDF linked as "carefully review the ..." on the waiver page. [VERIFIED; VERIFIED\*]
  - Claim them on the Claim Form, which asks for your Account Team ID, by **Nov 4, 9:00 PM ET**.
  - They arrive "within two (2) business days", and later when demand is high.
  - Each person can claim once, and each teammate claims for their own account.
  - The credits can be spent on "any use of the Services".
  - Every Model API account must have "a valid payment method on file before the Services can be used". Usage beyond the credits is charged to that card.
  - Using the credits "will not affect how your project is judged". [VERIFIED\*]
  - **The two documents disagree on expiry.** The Official Rules say the credits are "valid for a 10-day development window"; the Credit Terms say they "do not expire". Plan for 10 days. [VERIFIED\*]
- **Partner credits.** Baseten ($100 plus 2M tokens per minute), Modal ($100) and Fireworks ($25) offer credits to "select participants" for Meta's open-weight models ([event page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)). [VERIFIED\*]
- **Submission and ownership.**
  - Submit through the [Cerebral Valley submission portal](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit). [VERIFIED]
  - The project must be "original work product" that you alone own.
  - Paid outside technical help is allowed if the components stay your own work.
  - Open source is allowed if you follow its licenses and "the Submission enhances or builds upon the underlying open source product".
  - You keep ownership. The organizers get a perpetual, royalty-free, non-exclusive licence to the project, and you consent to recordings of your name, voice and likeness being used. [VERIFIED\*]
- **Prizes.** [VERIFIED\*]
  - Indie track, $400k in total: $150k, $100k, $75k, $50k and $25k.
  - Startup track, $550k in total: $250k, $150k, $75k, $50k and $25k.
  - Cerebral Valley pays the prizes and collects tax forms.
  - Up to $50k in bonus prizes and payment through Tremendous with a W-8BEN form are [UNVERIFIED].

### 1.6 What is still unverified
I searched the Official Rules and found none of the following [VERIFIED\* absence]:
- a demo video length (the word "minute" never appears);
- a requirement for a public repo;
- a rule that only work done during the event counts;
- a list of banned project types ("anti-projects").

These four come only from one participant's README, which cites the login-only Discord #rules channel ([README](https://github.com/sholaola23/meta-hackathon-2026)). As official rules they are [REFUTED]; as Discord rules they are [UNVERIFIED].

Also still unconfirmed [UNVERIFIED]:
- whether the owner and every teammate were accepted;
- the fields on the submission form, which is behind a login;
- what finalists must do on Nov 9;
- whether a project built on Llama would score under "Meta AI tooling";
- what "government-affiliated" means.

**Decision:** Until the Discord rules are seen, follow the strictest reading:
- a new public repo whose commits start on Oct 26 or later;
- a demo video of 3 minutes or less;
- present MediLens as an assistive reader that checks the registry and answers spoken questions, not a "simple image analyzer".

---

## 2. Meta integration options
This assumes no glasses, a Windows machine with no Android SDK, and about 9 days. "Real" means a live service; "simulator" means software that imitates the glasses.

| Rank | Option | Real, simulator or mock | What it needs | Feasibility | Status |
|---|---|---|---|---|---|
| 1 | Meta Model API `muse-spark-1.3` (Standard): reads the photo into structured JSON, then answers questions from that data | Real | Backend, API key, payment method; works with Expo Go | High | [VERIFIED] |
| 2 | Muse Voice Transcribe (`muse-voice-transcribe-1.0`): spoken questions in English or Tagalog | Real | Recording in WAV or raw PCM audio (`expo-audio`) | Medium | [VERIFIED]; recording path [VERIFIED\*] docs only |
| 3 | SAM 3.1 (`sam-3.1`, Meta's image-segmentation model, via the Responses API): crop the label area before reading | Real | Request format not researched | Low–medium; cap the time spent | exists and priced [VERIFIED\*]; usefulness [UNVERIFIED] |
| 4 | Muse Code (coding agent) during development | Real | Subscription; trains on your content by default | Not part of the app | [VERIFIED] |
| 5 | Meta open-weight models on partner hosts (Muse Spark Open, Muse Glimmer) | Real, run by third parties | Partner account or credits | Medium (fallback) | models [VERIFIED]; host prices [UNVERIFIED] |
| 6 | Using the glasses as an ordinary Bluetooth speaker for read-aloud | Real if owned; Android audio routing is inferred | Paired glasses | Medium, only if glasses are owned | [UNVERIFIED] |
| 7 | Wearables toolkit with its Mock Device Kit in an EAS development build | Simulator | Native module or community wrapper, development build, Kotlin 2.2+ | Low | [VERIFIED] |
| 8 | Wearables toolkit with real glasses (camera stream, photo capture) | Real but restricted | Glasses, Meta AI app Developer Mode; full toolkit not available in the Philippines | Very low | [VERIFIED] |
| 9 | Voice Invocations ("Hey Meta, start ...") | Real, development and beta channels only | Wearables toolkit plus the Wearables Developer Center | Very low | [VERIFIED] |
| 10 | Meta AI Connectors (Meta AI calls your API as a tool) | Developer preview, limited places | Onboarding | Very low | [UNVERIFIED] |
| 11 | Running Meta models on the phone (`react-native-executorch`; Glimmer) | Real libraries; Glimmer cannot run on a phone | Development build, SDK 55+, Android 13+ | Very low | [VERIFIED] |
| – | Llama on Meta Model API | Not offered | – | None | [VERIFIED] |

**Facts behind the ranking**
- **Meta Model API.**
  - The base address is `https://api.meta.ai/v1`, with a Bearer key (`MODEL_API_KEY`). It is "drop-in compatible with the OpenAI SDK, the Anthropic SDK" ([docs overview](https://dev.meta.ai/docs/overview.md)).
  - Hosted models: Muse Wonder (in preview), Muse Spark 1.1, 1.2 and 1.3, Muse Image, Muse Voice Transcribe and SAM 3.1.
  - It has no Llama models, and `llama.developer.meta.com` now redirects to `dev.meta.ai` ([models](https://dev.meta.ai/docs/models)). [VERIFIED]
  - It has been "generally available globally" since 2026-09-24. [VERIFIED] The claim that there is "no waitlist" is [REFUTED]; it is unconfirmed.
- **Access from the Philippines.**
  - The Philippines is not on Meta's list of restricted countries and has no model-specific restriction.
  - There is no list of allowed countries either. The help page only says the API is "available in most countries and territories where Meta AI is available and billing is supported" ([country policy](https://dev.meta.ai/legal/geographic-use-policy), [help page](https://dev.meta.ai/help/accounts-and-login/supported-countries)). [VERIFIED]
  - Secondary reports say Meta AI launched in the Philippines with Tagalog in 2024 ([techloy](https://www.techloy.com/meta-ai-announces-rollout-to-additional-countries-with-new-languages/)). [UNVERIFIED]
  - The only real proof is a live sign-up.
- **Wearables Device Access Toolkit (for the glasses).**
  - The software kit is native code only: Android 10+ with Kotlin 2.2+, or iOS 17.2+. Meta offers no React Native or Expo version ([getting started](https://wearables.developer.meta.com/llms.txt?product=all&version=1.0&document=products/dat/sections/guides/getting-started-toolkit)). [VERIFIED]
  - The Android kit is `com.meta.wearable:mwdat-*` version 1.0.1 (2026-10-09), published on Maven Central ([repo](https://github.com/facebook/meta-wearables-dat-android)). [VERIFIED]
  - React Native 0.88 (used by Expo SDK 58) sets Kotlin 2.2.0, minimum Android SDK 24 and target SDK 36 ([React Native build settings](https://raw.githubusercontent.com/facebook/react-native/v0.88.0/packages/react-native/gradle/libs.versions.toml)). [VERIFIED\*] Whether an Expo SDK 58 app actually compiles with the toolkit is [UNVERIFIED].
  - The CAMERA permission is needed only when the phone camera stands in for the glasses in the simulator. The claim that it is always required is [REFUTED].
- **Community wrappers for React Native/Expo.** Calling the community package the "only option" is [REFUTED]. None of the wrappers is from Meta. [VERIFIED]
  - `expo-meta-wearables-dat` 1.3.0 wraps toolkit 0.6 and downloads it from GitHub Packages, which needs a `GITHUB_TOKEN`.
  - `@chrisgocode/expo-meta-wearables-dat` 2.2.0 wraps toolkit 1.0.
  - All of them need a development build and a minimum of Android API 31.
- **Mock Device Kit (the simulator).** It "simulates the entire SDK stack". The phone camera or an H.265 video file can act as the glasses camera, but only inside a native build. It does not support display glasses ([Mock Device Kit](https://wearables.developer.meta.com/docs/develop/dat/mock-device-kit/)). [VERIFIED]
- **Country restriction.** "Only those in AI glasses supported countries will have access to the full capabilities of the toolkit, including the Wearables Developers Center." The Philippines is not on that list ([FAQ](https://developers.meta.com/wearables/faq), [country list](https://www.meta.com/help/ai-glasses/4961066940605960/)). [VERIFIED]
- **Publishing.**
  - Experimental features "can be built and tested against, though apps using them cannot be published yet" ([changelog](https://github.com/facebook/meta-wearables-dat-android/blob/main/CHANGELOG.md)).
  - Meta is not yet accepting toolkit apps for publishing. [VERIFIED]
  - Voice Invocations are labelled "[dev and beta only]" and "not supported in production release channels". [VERIFIED] They are not the only route through Meta AI, so that claim is [REFUTED]. The changelog's "[Experimental]" label is [UNVERIFIED].
  - Meta advises against "AI" in the app name, because it makes voice recognition less reliable. [VERIFIED]
- **Camera and audio on the glasses.** [VERIFIED]
  - `stream.capturePhoto()` during a live stream is not marked beta.
  - Taking a photo without a stream is in Beta.
  - Video tops out at 720x1280 over Bluetooth Classic, with compression that adapts to the connection.
  - Speech goes to the glasses as normal Bluetooth media audio (A2DP). Using the glasses microphone switches to the headset profile (HFP), which cuts audio to mono at 8 or 16 kHz.
  - How Android routes app speech to the glasses is [UNVERIFIED]; it is an inference.
- **Meta's terms for glasses apps** apply only if MediLens uses the glasses ([terms](https://wearables.developer.meta.com/terms)). [VERIFIED]
  - The technology "is not intended to be a medical device".
  - Use "for mission critical, life-saving, or hazardous activities" is banned.
  - Handling US patient health records (PHI) needs a signed Healthcare Addendum and Business Associate Agreement.

**Real, simulated or mock**
- **Real, can be shown live:** Muse Spark, Muse Voice Transcribe and SAM 3.1 on Meta Model API, plus Meta's open-weight models on partner hosts.
- **Simulated:** the glasses toolkit's Mock Device Kit.
- **Mock:** `react-native-nitro-glasses` 0.2.0 has no adapter for the toolkit. [UNVERIFIED] Any "seen through the glasses" footage that does not come from the toolkit must be labelled as a mock in the video.

**Decision: recommended design**
1. The app runs in Expo Go. It takes one or more photos with the torch on and shrinks them to about 1,280 px JPEG.
2. It sends them to the backend at `POST /scan`.
3. The backend rejects blurry photos (using the image library sharp), then calls `muse-spark-1.3` in Standard mode with the image and a JSON schema.
4. The backend checks the answer and looks the product up in the PH FDA registry.
5. The app reads a summary aloud with `expo-speech`, always in the same order.
6. Stretch: `POST /ask` takes a recorded question, transcribes it with Muse Voice Transcribe, and has `muse-spark-1.3` answer only from the label data it already read.

To score on "beyond a basic integration" (25% of the grade), show:
- several photos of one box combined into one record (up to 50 images per request [VERIFIED]);
- a legibility flag on every field, so the app says "I can't read this clearly" instead of guessing;
- questions spoken in Taglish;
- optionally, a SAM 3.1 crop of the label.

Glasses appear only as a roadmap slide.

---

## 3. AI providers

### 3.1 Recommended way to read the label: Muse Spark with structured output
- **What the model can do.** `muse-spark-1.3` is "Recommended for new work". It accepts images, has a context window of 1,048,576 tokens, and supports structured output and tool calls ([models](https://dev.meta.ai/docs/models)). [VERIFIED]
- **Sending images** ([image understanding](https://dev.meta.ai/docs/image-understanding)). [VERIFIED]
  - Send the image as base64 text inside the request (`image_url` with a data URL). It does not need to be hosted anywhere.
  - Limits: 50 MB per image and 50 images per request. Accepted types: JPEG, PNG, GIF, WebP and ICO.
  - A photo about 1,280 px wide costs roughly 1,300–1,500 input tokens.
- **Structured output** ([structured output](https://dev.meta.ai/docs/structured-output)). [VERIFIED]
  - Set `response_format` to `{type: "json_schema"}`. The model can then only produce JSON that fits the schema.
  - Schemas that refer to themselves are rejected with an error (HTTP 400). Schemas are limited to 10 levels of nesting and 5,000 properties.
  - A reply cut short by the token limit can still be broken JSON, so the backend must validate every reply.
- **Hidden reasoning** ([reasoning](https://dev.meta.ai/docs/reasoning.md)). [VERIFIED\*]
  - Muse Spark always reasons before it answers. Setting `reasoning_effort: "none"` "returns HTTP 400".
  - Reasoning tokens count against `max_tokens` and are billed as output.
  - If reasoning uses up the token budget, "the visible response may be truncated".
- **Accuracy is unknown.** Meta publishes no text-recognition (OCR) benchmark. Nobody knows how well it reads small, curved, glossy or foil print. [UNVERIFIED]
  - As a rough guide, Google's ML Kit wants each character to be "at least 16x16 pixels" ([ML Kit](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)). [VERIFIED]
  - So 1,280 px may be too small for blister-pack foil. Test 1,280 px against 2,048 px. [UNVERIFIED]
- **Blur check** ([sharp](https://sharp.pixelplumbing.com/api-input)). [VERIFIED]
  - The sharp library's `stats().sharpness` is the "standard deviation of a Laplacian convolution", a standard blur measure.
  - It is measured on the image as it was loaded, so run it on a fresh sharp instance after resizing.
  - You must set your own cut-off for "too blurry". Values from OpenCV tutorials do not apply.

Request shape (backend only; the API key never goes into the app):

```ts
import OpenAI from "openai";
const meta = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const res = await meta.chat.completions.create({
  model: "muse-spark-1.3",        // Standard mode; never a *-contributor ID
  reasoning_effort: "low",        // "none" is rejected for Muse Spark
  max_tokens: 4000,               // must cover hidden reasoning + JSON
  messages: [
    { role: "system", content: TRANSCRIBE_ONLY_PROMPT },
    { role: "user", content: [
      { type: "text", text: "Copy printed text exactly. Mark anything unreadable. Do not guess." },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpegB64}` } },
    ]},
  ],
  // the inner json_schema fields follow OpenAI's convention; confirm on Meta's structured-output page
  response_format: { type: "json_schema", json_schema: { name: "medicine_label", schema: LABEL_SCHEMA } },
});
if (res.model.includes("contributor")) throw new Error("contributor tier"); // ToS section 1 routing caveat
```

**Suggested schema fields.** This is a design suggestion.
- Brand name, generic names, strengths and dosage form.
- PH FDA registration number. Formats seen in the registry include `DR-`, `DRP-`, `DRHR-` and `DR-XY...`. [VERIFIED\*]
- Rx or OTC marking, batch or lot number, manufacture date, expiry date and manufacturer.
- Directions, warnings and storage instructions, copied word for word.
- A legibility value for each field: clear, partial or unreadable.
- **No field for the patient's name.**

### 3.2 Other ways to read text (not the main path)

| Option | Works in Expo Go | Cost | Notes | Status |
|---|---|---|---|---|
| On-device Google ML Kit via `expo-text-extractor` 2.0.0 | No (needs a development build) | Free | The model downloads through Google Play Services; until it does, reads return nothing | [VERIFIED] |
| Google Cloud Vision `DOCUMENT_TEXT_DETECTION` on the server | Yes | 1,000 images a month free, then $1.50 per 1,000 | Not a Meta tool; billing setup not checked | [UNVERIFIED] |
| tesseract.js 7 on the server | Yes | Free | No accuracy figures for packaging; offline fallback only | [UNVERIFIED] |

**Decision:** None of these go into the MVP. If digits such as strength or expiry need a second check, first try a second Muse Spark pass on a cropped image, so Meta's tools stay at the centre.

### 3.3 Llama
- **Meta's own API does not serve Llama.** [VERIFIED]
  - `llama.developer.meta.com` redirects to `dev.meta.ai`.
  - The old server `api.llama.com` still answers, but only with an authentication error (401). Whether old keys still work there is unknown.
- A third-party source says the Llama API was retired on 2026-07-06 ([promptfoo](https://www.promptfoo.dev/docs/providers/meta/)). [UNVERIFIED]
- **Llama 4 is only available from third parties.** OpenRouter lists Llama 4 Scout, with image input, at $0.10 per 1M input tokens and $0.30 per 1M output tokens ([OpenRouter](https://openrouter.ai/api/v1/models)). Groq and Together no longer list Llama 4 for pay-per-use. [UNVERIFIED]
- **Meta's current open-weight models** are Muse Glimmer and Muse Spark Open. [VERIFIED]
  - Glimmer is a 30-billion-parameter model under the Apache 2.0 licence that reads text and images.
  - It cannot run on a phone: its compressed builds are 17–31 GB, and Meta's on-device runtime (ExecuTorch) supports it only on NVIDIA (CUDA) or Apple (MLX) hardware ([Glimmer deployment](https://dev.meta.ai/docs/muse-glimmer/deploy)).
- **Decision:** Do not build on Llama. If the brief or pitch says "Llama", change it to "Meta Model API: Muse Spark". Whether a Llama build would count as "Meta open weights" for judging is [UNVERIFIED].

### 3.4 Reading aloud (text-to-speech)
- **Meta has no text-to-speech API.** Muse Voice Transcribe "is speech-to-text only; it does not synthesize speech" ([overview](https://dev.meta.ai/docs/overview.md)). [VERIFIED]
- Meta's MMS-TTS has a Tagalog voice, but it has three problems ([model card](https://huggingface.co/facebook/mms-tts-tgl)). [VERIFIED] **Decision:** do not use it.
  - Its CC-BY-NC 4.0 licence forbids commercial use.
  - It runs in Python on your own server.
  - No hosting service offers it.
- **Decision: use `expo-speech`, which is included in Expo Go** ([docs](https://docs.expo.dev/versions/latest/sdk/speech/)). [VERIFIED]
  - Set `rate` and `pitch` (1.0 is normal), and pass `language` as a standard code such as `en-US` (BCP 47).
  - Pick a voice at runtime with `Speech.getAvailableVoicesAsync()`. [VERIFIED\*]
  - On Android, `pause()` and `resume()` are "not available" and throw an error. Build pause and resume yourself:
    - split the text into chunks shorter than `Speech.maxSpeechInputLength`;
    - track progress with `onDone` and `onBoundary`;
    - pause by calling `stop()`;
    - resume by speaking again from the saved chunk.
  - Whether the demo phone has a Filipino voice is [UNVERIFIED]. Test it.

### 3.5 Speech-to-text (optional spoken questions)
- **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`) ([speech-to-text docs](https://dev.meta.ai/docs/speech-to-text)). [VERIFIED]
  - Costs $0.18 per hour of audio.
  - Supports 25 languages, including English and Tagalog, and handles mixing them in one sentence.
  - Endpoints:
    - Upload a file to `POST /v1/asr/transcribe`. It must be a WAV file: mono, 16-bit, at 16 or 24 kHz.
    - Or stream raw audio to `wss://api.meta.ai/v1/asr/realtime`: mono, 16-bit little-endian PCM.
- **Limits and privacy** ([pricing](https://dev.meta.ai/docs/pricing-rate-limits)). [VERIFIED\*]
  - Up to 256 streams at once and 16,000 streams per hour.
  - Zero data retention (ZDR) "is priced at parity with Standard mode".
  - "Contributor mode isn't available for Muse Voice Transcribe", so the audio is never used for training.
- **Recording in Expo Go** ([expo-audio](https://docs.expo.dev/versions/v58.0.0/sdk/audio/)). [VERIFIED\*] docs only; not tested on a device [UNVERIFIED]
  - `expo-audio` (~58.0.10) is "Included in Expo Go".
  - Its standard Android recorder cannot save WAV. It saves only `3gp`, `mpeg4`, `amrnb`, `amrwb`, `aac_adts`, `mpeg2ts` and `webm`.
  - SDK 58 adds an `AudioStream` class that "captures PCM audio from the microphone in real-time" and can write `wav` or `pcm` files, on Android and iOS.
  - Fallback: record AAC and convert it on the server. The conversion tool was not researched. [UNVERIFIED]
- **On-device alternative.** `expo-speech-recognition` 58.0.0 needs a development build. On Android, continuous listening needs Android 13+, and offline recognition needs a downloaded language pack. [VERIFIED] Not in the MVP.

### 3.6 Costs

| Item | Price | Status |
|---|---|---|
| Muse Spark 1.3, Standard mode | Per 1M tokens: $1.25 input, $4.25 output, $0.15 cached input. Reasoning is billed as output. | [VERIFIED]; [VERIFIED\*] |
| Muse Spark "Contributor" model IDs | Per 1M tokens: $0.10, $0.20 and $0.002. Meta may train on your content, and personal data is banned. | [VERIFIED] |
| Muse Voice Transcribe | $0.18 per hour of audio | [VERIFIED] |
| SAM 3.1 | $2.50 per 1,000 images | [VERIFIED\*] |
| Web search add-on | $2.50 per 1,000 searches; not recommended for medical facts | [VERIFIED\*] |
| Rate limits (per team) | `muse-spark-1.3`: 3,000 requests and 4M tokens per minute. `sam-3.1`: 3,000 requests per minute. | [VERIFIED\*] |
| Free tier | None on the pricing page. A "$20 for new accounts" offer appears only in news reports. | [VERIFIED]; [UNVERIFIED] |
| Hackathon credits | $150 per accepted participant, plus partner credits for selected participants | [VERIFIED\*] |
| Estimated cost per scan | About 2,300 input tokens plus 700–2,400 output tokens (including reasoning): roughly **$0.006–$0.013**. $150 covers about 11,000–25,000 scans. A 10-second spoken question costs about $0.0005 to transcribe plus about $0.004 to answer. | [UNVERIFIED] estimate; measure it from `usage.completion_tokens_details.reasoning_tokens` |

### 3.7 Privacy and usage terms
- **Standard mode.** "Meta does not use your Content from Standard Services to train Meta Models" ([commitments](https://dev.meta.ai/legal/commitments)). [VERIFIED]
- **Contributor mode.** Meta may train on what you send. The terms say "You must not submit sensitive, confidential, or personal information to the Contributor Services" ([terms of service](https://dev.meta.ai/legal/terms-of-service), updated 2026-10-09, §6.2). [VERIFIED]
- **Check every reply.** §1 says "the system may route you to a Contributor Model, and you are responsible for ensuring that you are accessing and using a Standard or Contributor Model as you intend." [VERIFIED\*] Check the model name on every response.
- **Muse Code** trains on your content by default. Turn that off, or never paste real labels into it. [VERIFIED]
- **Retention.** Meta keeps content "as needed", including for abuse and safety review, with no fixed period. [UNVERIFIED] Whether zero data retention is offered for the text models is unknown. [UNVERIFIED]
- **Acceptable use policy** ([policy](https://dev.meta.ai/legal/acceptable-use-policy)). [VERIFIED] It bans:
  - "unauthorized or unlicensed practice of any profession", which includes medicine;
  - relying on outputs for health decisions "without a qualified person reviewing the Outputs";
  - failing to tell end users about known material risks;
  - handling health information without a legal right to do so.
- **Decision: present MediLens strictly as "reads your label aloud".**
  - Speak a disclaimer the first time the app runs.
  - Never give dose advice beyond the printed text.
  - Say "unclear" rather than guess.
  - Tell users to "confirm with your pharmacist or doctor".
  - Do not store photos by default.
  - Publish a privacy notice.
- **Data sent to the medicine databases.** PH FDA, RxNav and openFDA receive only drug names or registration numbers, never personal data. Philippine privacy law on health data was not researched. [UNVERIFIED]

---

## 4. Medication references

### 4.1 Data sources for the MVP

| Source | Role | Access and limits | Terms | Status |
|---|---|---|---|---|
| The user's own pack, read by Muse Spark | The only thing read aloud as "your medicine" | – | Meta's usage policy (see 3.7) | – |
| PH FDA Verification Portal | Confirms the product registration (CPR) and finds FDA counterfeit warnings | `GET https://verification.fda.gov.ph/api/search?q=<term>`; no login; returns JSON. Not documented by FDA. Responses carry `X-RateLimit-Limit: 15`; the time window is unknown. About 370 KB per brand search. curl's default identifier is blocked (403); an honest app identifier is accepted (200). | "Shall only be used for purposes of verification and shall in no case be used for any unlawful purpose". Not regulatory advice. No API licence or terms of service. robots.txt allows all crawling. | [VERIFIED]; [VERIFIED\*] |
| RxNav / RxNorm (US National Library of Medicine) | Corrects spelling of generic drug names from the scan | No key needed. 20 requests per second per IP, or 100 with a free key. Cache results 12–24 hours. | Free. NLM credit required. Avoid classes that come from SNOMED. | [VERIFIED] |
| openFDA `drug/label`, `drug/ndc` | Optional and off by default: US reference information at the ingredient level | Without a key: 240 per minute and 1,000 per day per IP. With a free key: 120,000 per day. | Public domain (CC0) unless marked otherwise. Credit requested. Says: "Do not rely on openFDA to make decisions regarding medical care." | [VERIFIED] |

Sources: [FDA Advisory 2023-2238](https://www.fda.gov.ph/fda-advisory-no-2023-2238-utilization-of-the-food-and-drug-administration-fda-verification-portal/), [PH FDA search example](https://verification.fda.gov.ph/api/search?q=biogesic), [RxNav terms](https://lhncbc.nlm.nih.gov/RxNav/TermsofService.html), [openFDA keys](https://open.fda.gov/apis/authentication/), [openFDA terms](https://open.fda.gov/terms/).

### 4.2 Using PH FDA data correctly
- **What a registry record contains.** [VERIFIED]
  - Drug records (`cdrr`) have 15 fields: registration_number, generic_name, brand_name, dosage_strength_form, classification, packaging, manufacturer, country_of_origin, trader, importer, distributor, app_type, issuance_date, expiry_date and pharmacologic_category.
  - Strength and form share one free-text field, written inconsistently.
  - Trader, importer and distributor are often empty.
- **`expiry_date` is when the registration certificate expires, not the medicine.** Never read it aloud as the product's expiry date. [VERIFIED]
- **Match on the registration number first.** One brand and strength can have several registrations. "Biogesic 500 mg Tablet" appears as DR-153 (over the counter) and DR-XY39670 (prescription). [VERIFIED\*]
- **Counterfeit warnings.** The same response includes FDA advisories (`fdawebsite`). For example: "FDA Advisory No.2026-0927 || Public Health Warning Against the Purchase and Use of the Counterfeit Drug Product 'Paracetamol (Biogesic) 500 mg Tablet'". [VERIFIED\*]
  - **Decision:** Say "FDA has warned about counterfeit versions of this product; check with your pharmacist." Never say the user's pack is fake.
- **Other data in the response.** [VERIFIED\*]
  - `cdrr_PIPIL` links patient leaflets on Google Drive, matched by registration number. Reading them is a stretch idea. Muse Spark accepts PDFs [VERIFIED], but whether we may reuse the leaflets is [UNVERIFIED].
  - `csl_batch` and `csl_lot` lists also exist; what they hold is [UNVERIFIED].
- **Decision: how to call it.**
  - Make one or two lookups per scan, from the backend only.
  - Send an honest app identifier (User-Agent), for example `MediLensAI/0.1`. FDA's server accepted that on 2026-10-27 [VERIFIED\*]. Never pretend to be a browser.
  - Cache results for at least 24 hours, and load the demo products into the cache in advance.
  - Time out after a few seconds and say "I couldn't verify this right now."
  - Do not crawl the whole registry.
  - Ask PH FDA for permission, or a data feed, before using it after the hackathon.

### 4.3 Legal notes
- **PH FDA portal.** FDA allows use "only for purposes of verification". Reading that as covering a third-party app is our own interpretation, which FDA has not confirmed. Nothing licenses automated use, and the site footer says "All Rights Reserved". [VERIFIED]
- **openFDA.** Public domain (CC0). Do not suggest that FDA endorses the app. Brand names remain trademarks. [VERIFIED]
- **RxNav.** Free for normal use, with credit to NLM. [VERIFIED]
- **WHO ATC/DDD drug classification** ([WHO collaborating centre](https://atcddd.fhi.no/copyright_disclaimer/)). [VERIFIED] **Decision:** Do not ship the index, and cite the WHO collaborating centre if any classification code is shown.
  - "Copying and distribution for commercial purposes is not allowed."
  - "Changing or manipulating the material is not allowed."
- **Meta's MMS-TTS and Seamless speech models** are under CC-BY-NC, which allows non-commercial use only. [VERIFIED for MMS-TTS; UNVERIFIED for Seamless]
- **Medical device rules.** Whether MediLens counts as a medical device under Philippine rules was not researched. [UNVERIFIED]

### 4.4 What is NOT possible
- **Using an official PH FDA API or bulk download.** There is no official API. A 2023 advisory mentioned Excel and CSV export, but the 2026 portal code has no export feature. [VERIFIED]
- **Verifying a batch, the medicine's expiry date or authenticity against the registry.** Being missing from the registry does not mean a product is fake. FDA also invites corrections to the list. [VERIFIED; corrections note UNVERIFIED]
- **Looking up Philippine brands in US databases.** RxNorm, openFDA and DailyMed are US-focused. For example, "biogesic" returns no RxNorm drug group. [UNVERIFIED] Never read US label text as if it were a Philippine product's label.
- **Querying the Philippine National Formulary.** It exists only as a PDF (essential medicines list as of Nov 2022). At most, use it for a hand-made list of generic names. [UNVERIFIED]
- **Bundling the WHO ATC index.** [VERIFIED]
- **Answering dose or interaction questions beyond the printed label.** Meta's policy rules it out, and so does liability. [VERIFIED; the scope limit is a Decision]

---

## 5. Mobile stack

### 5.1 Decisions
- **Use Expo SDK 58**, with React Native 0.88 and React 19.3.0. It has been the current stable release since 2026-10-15, and `expo` 58.0.19 is the latest on npm ([SDK 58 announcement](https://expo.dev/changelog/sdk-58), [npm](https://registry.npmjs.org/expo)). [VERIFIED]
- **Develop in Expo Go for SDK 58.** Install it from [expo.dev/go](https://expo.dev/go), which offers an Android install marked "SDK 58 (latest)". As of Oct 27, Expo has not announced the SDK 58 version on the Play Store. [VERIFIED]
- **Do not start on SDK 57.** Expo says "The new Expo Go will support only SDK 58", so a Play Store update during the event would break an SDK 57 project. [VERIFIED]
  - The claim that new projects are still created on SDK 57 is [REFUTED]. Since Oct 21, `create-expo-app` recommends SDK 58.
- **Check the Node version.** Expo's tools need Node 22.13+, 24.3+ or 26+. Run `node -v` and confirm the installed "Node 24" is at least 24.3.0. [VERIFIED]

### 5.2 App packages for the MVP
Versions are the ones `npx expo install` picks, taken from SDK 58's [bundledNativeModules.json](https://raw.githubusercontent.com/expo/expo/sdk-58/packages/expo/bundledNativeModules.json). [VERIFIED\*]

| Package | Version | In Expo Go | Use | Status |
|---|---|---|---|---|
| expo | 58.0.19 | – | The SDK itself | [VERIFIED] |
| react-native / react | 0.88.0 / 19.3.0 | – | – | [VERIFIED] |
| expo-camera | ~58.0.12 | Yes, real phones only | `CameraView` with `enableTorch`; `takePictureAsync({quality, base64})`. Do not use `skipProcessing`: it ignores `quality` and can rotate photos wrongly. The camera permission is declared automatically, but the app must still ask for it at runtime. | [VERIFIED]; [VERIFIED\*] |
| expo-image-manipulator | ~58.0.15 | Yes | Shrink the photo: `ImageManipulator.manipulate(uri).resize({width: 1280, height: null})`, then `renderAsync()`, then `saveAsync({format: JPEG, compress, base64: true})`. The older `manipulateAsync` is deprecated. | [VERIFIED\*] |
| expo-speech | ~58.0.3 | Yes | Reading aloud; build pause and resume in chunks on Android | [VERIFIED] |
| expo-image-picker | ~58.0.10 | Yes | Backup: pick from the gallery or use the phone's own camera app | features [UNVERIFIED]; version [VERIFIED\*] |
| expo-audio | ~58.0.10 | Yes | Stretch: record a spoken question (`AudioStream` raw audio or WAV) | docs [VERIFIED\*]; on a device [UNVERIFIED] |
| React Native `AccessibilityInfo` and `Text` | Built in | Yes | `announceForAccessibility` for short status messages (on Android they cut off current speech); `isScreenReaderEnabled`; leave `allowFontScaling` on (the default) | [UNVERIFIED] |

Other notes:
- The expo-camera `autofocus` setting works on iOS only. [UNVERIFIED]
- Android 16 (API 36) deprecates `View.announceForAccessibility`, and React Native 0.88 targets API 36. Test announcements with TalkBack (Android's screen reader) switched on. [UNVERIFIED]; target API [VERIFIED\*]

### 5.3 Backend

| Package | Version | Use | Status |
|---|---|---|---|
| Node.js | 24.3.0 or newer | Runtime | [VERIFIED] |
| express | 5.3.0 | Errors in async handlers reach the error middleware automatically. Set the `express.json()` size limit explicitly so base64 photos fit; the default was not re-checked. | [UNVERIFIED] |
| sharp | 0.35.5 (latest release noted 2026-09-27) | Blur check with `stats().sharpness`; resizing | feature [VERIFIED]; version [UNVERIFIED] |
| openai (npm) | Current release; not pinned by this research | Client pointed at `https://api.meta.ai/v1` | compatibility [VERIFIED]; version [UNVERIFIED] |
| A JSON schema validator | Not researched | Checks the model's JSON | [UNVERIFIED] |
| supertest 7.3.1 with vitest 5.0.5 (or jest 30.5.2) | – | API tests | [UNVERIFIED] |

### 5.4 App tests
Use `jest-expo` ~58.0.12, `jest` 30.5.2 and `@testing-library/react-native` 14.1.0, which needs Node 22.13+ or 24+. Do not use `react-test-renderer`: it is deprecated and does not support React 19 ([Expo unit testing](https://docs.expo.dev/develop/unit-testing/)). [UNVERIFIED; the jest-expo version is VERIFIED\*]

### 5.5 Packages that need a development build (not in the MVP)

| Package | Purpose | Status |
|---|---|---|
| `expo-dev-client` ~58.0.15 and `expo-build-properties` ~58.0.11 | Development client; changing build settings such as the minimum Android version | [VERIFIED\*] |
| `expo-text-extractor` 2.0.0 | On-device text recognition with ML Kit (needs Google Play Services) | [VERIFIED]; builds on SDK 58 [UNVERIFIED] |
| `expo-speech-recognition` 58.0.0 | On-device speech recognition (its README still installs ^57) | [VERIFIED] |
| `@chrisgocode/expo-meta-wearables-dat` 2.2.0 | Glasses through the toolkit's 1.0 version (community package) | [VERIFIED] |
| `react-native-executorch` | Models on the phone (needs SDK 55+, the New Architecture, Android 13+) | [VERIFIED] |
| `react-native-vision-camera` 5.2.3 | Processing camera frames live; it has no text-recognition plugin | [UNVERIFIED] |

### 5.6 Expo Go vs a development build, without a local Android SDK
- **Expo Go runs only native code that is already built into it.** Every MVP package above is included, so no build is needed during development. [VERIFIED]
- **Any extra native package needs a development build.** That covers ML Kit, on-device speech recognition, the glasses toolkit and ExecuTorch. [VERIFIED]
  - Build it in the cloud with `eas build --platform android --profile development`. It runs on Expo's servers, so no local Java or Android SDK is needed.
  - The free plan allows 15 Android builds a month, in a low-priority queue, with a 45-minute time limit and no extra charges. The Starter plan costs "$19/month plus additional usage cost" ([Expo pricing](https://expo.dev/pricing)). [VERIFIED]
  - Whether development builds and APK builds count the same towards the 15 is [UNVERIFIED].
- **You need a physical Android phone.** Without the Android SDK there is no emulator, and expo-camera does not work in emulators anyway. [VERIFIED]
- **Build an installable APK for the demo**, so the live demo does not depend on Expo Go or the development server. EAS builds an app bundle (AAB) by default, and "AABs can't be installed directly on your device" ([APK guide](https://docs.expo.dev/build-reference/apk/)). [VERIFIED] Add this to `eas.json`:

```json
{ "build": { "preview": { "android": { "buildType": "apk" } } } }
```

  Then run `eas build --platform android --profile preview`. The APK must point at a backend reachable over public HTTPS, not localhost. Hosting was not researched. [UNVERIFIED]

---

## 6. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Owner decision needed |
|---|---|---|---|---|---|
| R1 | The owner or a teammate was not accepted, so MediLens cannot be submitted | Unknown | Critical | Check the acceptance email or dashboard today. Keep only accepted people on the team, and make sure the Representative is eligible. | Yes |
| R2 | Disqualification: the undefined "government-affiliated" rule, the family and household rule, being under 18, or employer rules on accepting prizes or credits | Unknown | Critical | Get written confirmation from Cerebral Valley before doing more work. Check employer or civil-service rules. | Yes |
| R3 | The Discord rules turn out to be binding: 3-minute video, public repo, only work from the event, ban on "Simple Image Analyzers" | Medium | High | Use a new public repo with commits from Oct 26 on. Keep the video to 3 minutes or less. Present MediLens as an assistive reader with registry checks and voice Q&A. Ask in Discord office hours. | Yes (whether to reuse older code) |
| R4 | The Meta account, payment method or credits fail from the Philippines, or the credits arrive late | Low–Medium | High | Sign up, add a card and claim the credits today, then make one test call. Fallback: Meta's open-weight models on a partner host, which the Credit Terms allow without a Model API account (§3.8), or OpenRouter's `muse-spark-1.3`, whose privacy tier is unknown [UNVERIFIED]. | No |
| R5 | The model misreads a strength, dose or expiry and the app reads it out confidently | Medium | Critical | Reject blurry photos. Tell the model to copy text only. Flag legibility per field and cross-check against the registry. Say "unclear" instead of guessing, and always tell users to check with a pharmacist. Measure accuracy field by field on 20–30 local packs before the demo. | No |
| R6 | Hidden reasoning cuts the JSON short, or adds delay and cost | Medium | Medium | Use `reasoning_effort` "low" or "minimal" and a generous `max_tokens`. Parse and validate the JSON, and retry once on failure. Log reasoning token counts. | No |
| R7 | Photos with patient names reach a Contributor model (which Meta may train on), or real labels are pasted into Muse Code (which trains by default) | Low if set up correctly | High | Use only Standard model IDs and check the model name on every reply. Turn off Muse Code's training setting or use made-up data. Do not store photos. Publish a privacy notice. | Yes (what to keep) |
| R8 | The app comes across as giving medical advice, which Meta's policy bans | Medium | High | Present it as a label reader. Speak a disclaimer on first run. Limit Q&A to the printed text and decline anything beyond it. | Yes (Q&A scope) |
| R9 | The PH FDA endpoint changes, hits its limit of 15, or blocks requests during judging | Medium | Medium | Wrap it in its own module with a timeout and a 24-hour cache, and pre-load the demo products. Use an honest app identifier. Fall back to "couldn't verify". Ask FDA for permission after the event. | Yes (use it at all?) |
| R10 | The registry is misused: a false "fake or unregistered" alarm, or the certificate expiry read out as the medicine's expiry | Medium | High | Never say "fake". Say "no matching registration found; ask your pharmacist." Read the expiry only from the pack. Present FDA advisories as context. | No |
| R11 | Expo Go and the SDK fall out of step during the event | Medium | Medium | Build on SDK 58 with Expo Go from expo.dev/go, and demo from an EAS APK. | No |
| R12 | Free EAS limits near the deadline: 15 builds, slow queue, 45-minute limit | Medium | Medium | Stay in Expo Go. Make the first APK by Nov 2 and use at most 3 builds. Pay $19/month for Starter if the queue gets long. | Yes (spend) |
| R13 | Speech problems: no Filipino voice on the demo phone, no Android pause or resume, clashes with TalkBack | Medium | Medium | Start with English and check available voices at runtime. Play in chunks with a repeat option. Test with TalkBack on. | Yes (languages) |
| R14 | Time sinks into glasses work: native code only, not available in the Philippines, features that can't be published | High if attempted | High | Keep it out of the MVP and show it as a roadmap slide. Try the Mock Device Kit only on a separate branch after the MVP is finished. | Yes |
| R15 | The backend is down or slow during live judging: slow first request, a free host going to sleep, or a laptop as the server | Medium | High | Deploy early to a stable HTTPS host, add a health check and keep it awake. Have a backup video. | Yes (host) |
| R16 | The API key leaks through the public repo or the app | Medium | High | Keep the key only in the server's environment and keep `.env` out of git. Scan for secrets before making the repo public. Replace the key if it leaks. | No |
| R17 | No or slow internet: the cloud-only design stops working | Medium | Medium | Give a clear spoken error and a retry. Add offline ML Kit reading later, in a development build. | Yes |
| R18 | Unresolved licensing and regulation: non-commercial models, the WHO index, PH FDA data use, PH privacy law, medical-device rules | Low during the hackathon, high afterwards | High | Avoid non-commercial components and the WHO index. Keep data to a minimum. Get legal review before any commercial launch. | Yes |
| R19 | About 9 days left | High | High | Cut everything to "scan, read aloud, verify". Set daily milestones and stop adding features on Nov 3. | Yes |

**Critical path (to manage R19).** These are decisions, not facts.
- **Oct 27:** eligibility, Meta account and credits, a test call, the repo, the Expo app skeleton.
- **Oct 28–30:** scan to JSON to speech; blur check; PH FDA lookup and cache; an accessibility pass with TalkBack on.
- **Oct 31–Nov 1:** accuracy test on 20–30 packs and fixes; spoken questions if time allows.
- **Nov 2:** first EAS APK; rehearse the live demo.
- **Nov 3:** a video of 3 minutes or less, the README and disclaimers, a second APK if needed.
- **Nov 4, Manila evening:** submit. The hard deadline is Nov 5 at 10:00 AM Manila time.

---

## 7. Questions only the owner can answer
1. **Acceptance.** Were you accepted, under the email you applied with? Which track did you apply for, Indie or Startup? Was every teammate accepted individually?
2. **Eligibility.** Is anyone on the team, or in their immediate family or household, "government-affiliated" (for example a Philippine government employee, including contractual or job-order staff)? Is everyone 18 or older? Does any employer restrict accepting prizes or credits?
3. **Existing work.** Does MediLens have code, designs or assets made before Oct 26? Will you start a new public repo and rebuild during the event?
4. **Discord rules.** Have you seen the Discord #rules channel or the participant dashboard? Please paste exactly what they say about video length, repo visibility, earlier work, problem statements and banned project types.
5. **Meta account.** Can you open a Meta Model API account from the Philippines with a card Meta accepts, and claim the $150 credits (you need your Team ID)? Please report the result of one test call.
6. **Llama.** Is "Llama" a firm requirement in your brief, pitch or application? Or can the stack be described as Meta Model API with Muse Spark?
7. **Glasses.** Do you own Ray-Ban Meta or Oakley Meta glasses? If so, will you test them as an ordinary Bluetooth speaker for the read-aloud?
8. **Languages and demo phone.** Must the MVP read and understand only English, or Filipino/Tagalog as well? Which Android phone and Android version will run the demo? Does it have Google Play services, and which text-to-speech voices are installed?
9. **PH FDA data.** Are you comfortable calling the undocumented PH FDA endpoint for the demo (honest app identifier, one or two lookups per scan, cached)? Will you ask PH FDA for permission or a data feed afterwards?
10. **Data and commercial plans.** Will the app store scan history, photos or extracted text? If so, where and for how long? Do you plan to sell or commercialise MediLens after the hackathon?
11. **Budget and hosting.** Are you willing to pay for API use beyond the credits, the EAS Starter plan ($19/month) if needed, and backend hosting? Which host?
12. **Q&A scope.** Should spoken answers stick strictly to what is printed on the pack (recommended), or include general drug information?
13. **Testers.** Do you have access to low-vision testers, or an organisation for them, for a short test and a quote for the Impact story? Do they consent to being filmed?
14. **Finals.** If MediLens reaches the finals, can you present live at the Nov 9 closing ceremony? Its start time has not been published, and it may fall at night in Manila.

---

## Appendix: how the judge resolved conflicting findings
- **$150 credits.** Topic 3 said the amount appears only in a promotional email. In fact both the Official Rules and the Credit Terms PDF state it. [VERIFIED\*]
- **"Official Rules will be published".** The note on the event page is out of date; the rules are on the waiver page. [VERIFIED\*]
- **Discord-only rules** (video length, repo, earlier work, banned projects). They are not in the Official Rules and remain [UNVERIFIED].
- **How long the credits last.** The Official Rules say a "10-day development window"; the Credit Terms say they "do not expire". Plan for 10 days.
- **PH FDA blocking (403).** Only curl's default identifier is blocked; an honest app identifier gets a 200 response. [VERIFIED\*] So there is no need to pretend to be a browser.
- **SAM model ID.** Meta's docs and rate-limit table use `sam-3.1`. The product page shows `sam-3-1`. Use the docs ID and confirm it in the console.
- **"GA with no waitlist".** GA is verified. "No waitlist" is unconfirmed.
- **Does Muse Spark accept images?** Topic 1 was unsure. The image-understanding docs confirm it does. [VERIFIED]
- **Is the glasses toolkit still a developer preview?** The FAQ says version 1.0 is out of preview, while the GitHub READMEs still say "developer preview". Go by each feature's own label: Experimental and Beta features cannot be published.
- **Voice Invocations.** The API reference says "[dev and beta only]" and the changelog says "[Experimental]". Either way, they cannot ship in a production app.