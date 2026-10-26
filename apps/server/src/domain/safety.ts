/**
 * Deterministic question safety gate (spec §4.3 step 1). Runs before any
 * model call. Refusal patterns are checked before anything is allowed, so a
 * question that mentions the label AND asks for personal advice is refused.
 * Patterns err towards refusing: an over-refusal costs a pharmacist visit, an
 * under-refusal could be dosing advice.
 */

export type RefusalReason =
  | 'personal_dose'
  | 'start_stop'
  | 'diagnosis'
  | 'special_population'
  | 'interaction'
  | 'personal_safety'
  | 'pill_identification';

export type AllowedIntent =
  'read_label' | 'explain_text' | 'strength' | 'unclear_parts' | 'registry' | 'other_label';

export type QuestionClass =
  { allowed: true; intent: AllowedIntent } | { allowed: false; reason: RefusalReason };

const REDIRECT = 'Please ask a pharmacist or your doctor.';

export const REFUSAL_TEXT: Record<RefusalReason, string> = {
  personal_dose: `I can't tell you how much to take. I can only read what is printed on the label. ${REDIRECT}`,
  start_stop: `I can't advise you to start, stop or change a medicine. ${REDIRECT}`,
  diagnosis: `I can't diagnose symptoms or say whether this medicine treats them. ${REDIRECT}`,
  special_population: `I can't say whether this medicine is suitable for children, older people, or during pregnancy or breastfeeding. ${REDIRECT}`,
  interaction: `I can't check whether this medicine is safe to take with other medicines, food or alcohol. ${REDIRECT}`,
  personal_safety: `I can't say whether this medicine is safe for you. ${REDIRECT}`,
  pill_identification: `I can't identify a medicine from how a pill looks. ${REDIRECT}`,
};

const PILL = String.raw`(?:pills?|tablets?|capsules?|caplets?|tabs?)`;
/** Who the question is about: me, someone else, or a group ("diabetics"). */
const SUBJECT = String.raw`(?:i|you|he|she|we|they|someone|anyone|my \w+|\w+s)`;
const COUNT = String.raw`(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|half|a)`;
/** A count with no unit ("is 3 a day ok?", "what if she takes two?"); excludes "a". */
const BARE_COUNT = String.raw`(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|half)`;
const AMOUNT_UNIT = String.raw`(?:${PILL}|mg|mcg|ml|g|doses?|teaspoons?|tsp|tablespoons?|tbsp|spoons?|drops?|sachets?)`;
const CONDITION = String.raw`(?:diabet\w*|blood pressure|hypertensi\w*|kidneys?|renal|liver|heart|asthma\w*|ulcers?)`;
const LOOKS = String.raw`(?:white|yellow|pink|blue|red|orange|green|brown|purple|grey|gray|black|round|oval|oblong|small|big|large|tiny|loose|scored|coated|shiny)`;

/** Checked in this order; the first matching reason wins. */
const REFUSALS: readonly [RefusalReason, readonly RegExp[]][] = [
  [
    'pill_identification',
    [
      new RegExp(String.raw`\b${LOOKS}\b.*\b${PILL}\b`),
      new RegExp(String.raw`\bwhat(?:'s| is)? (?:this|that|these|the) ${PILL}\b`),
      new RegExp(String.raw`\bwhat ${PILL} (?:is|are) (?:this|that|these|it)\b`),
      new RegExp(String.raw`\b(?:identify|recogni[sz]e)\b.*\b${PILL}\b`),
      /\bwhich (?:medicine|drug) is this\b/,
    ],
  ],
  [
    'special_population',
    [
      /\bpregnan/,
      /\bbreast ?feed/,
      /\bnursing\b/,
      /\blactat/,
      /\b(?:child|children|kids?|baby|babies|infants?|toddlers?|newborns?|teens?|teenagers?)\b/,
      /\b(?:son|daughter|grand(?:son|daughter|child))\b/,
      /\b\d+ ?-?(?:years?|yrs?|months?|mos?) ?-?old\b/,
      /\b(?:elderly|seniors?|old people|older people)\b/,
      /\b(?:grand(?:ma|pa|mother|father|parents?)|lol[ao])\b/,
      /\bwhat age\b/,
      /\bage\b/,
      /\b(?:buntis|sanggol|anak|bata)\b/,
    ],
  ],
  [
    'interaction',
    [
      /\binteract/,
      /\b(?:combine|combining|mix|mixing)\b/,
      /\btogether\b/,
      /\bat the same time\b/,
      /\b(?:alcohol|beer|wine|liquor|drinking)\b/,
      /\b(?:take|taking|use|using|have|drink)\b.*\b(?:with|and|plus|after|before)\b.*\b(?:other|another|ibuprofen|paracetamol|acetaminophen|aspirin|antibiotics?|medicines?|medications?|meds|drugs?|pills?|tablets?|vitamins?|supplements?|food|coffee|milk|juice)\b/,
      /\bwith (?:my )?(?:other|another) (?:medicines?|medications?|meds|drugs?|pills?)\b/,
    ],
  ],
  [
    'start_stop',
    [
      /\b(?:stop|stopped|stopping|quit|discontinue|start|starting|switch|switching|skip|skipping|resume)\b/,
      /\b(?:keep|continue) (?:taking|using)\b/,
      /\bchange (?:to|from|my)\b/,
      /\bmissed (?:a )?dose\b/,
    ],
  ],
  [
    'personal_dose',
    [
      /\bhow (?:many|much)\b/,
      /\bhow often should\b/,
      /\b\d+(?:\.\d+)? ?(?:kg|kgs|kilos?|kilograms?|lbs?|pounds)\b/,
      /\bweigh/,
      /\bshould (?:i|he|she|we|they) take\b/,
      /\b(?:dose|dosage) (?:for|should|do)\b/,
      /\bwhat dose\b/,
      /\b(?:double|extra|more) (?:dose|tablets?|pills?)\b/,
      /\boverdos/,
      /\btoo (?:much|many)\b/,
      /\b(?:maximum|max)\b/,
      /\bat once\b/,
      // "took" means a dose was taken, except "took a photo"
      /\btook (?!(?:a |an |another |the |this |my )?(?:photos?|pictures?|pics?|images?|shots?|snaps?)\b)/,
      /\bmore than (?:the label|the box|the pack|it says|directed|recommended|prescribed|printed|stated|written)/,
      /\bper (?:kg|kgs|kilos?|kilograms?|pounds?|lbs?)\b/,
      /\bmg ?\/ ?kg\b/,
      // "is 4 tablets a day okay?", "would 1000 mg be fine?"
      new RegExp(
        String.raw`\b${COUNT} ?${AMOUNT_UNIT}\b.*\b(?:ok|okay|fine|alright|all right|enough|too|safe|good|normal)\b`,
      ),
      // bare counts: "is 3 a day ok?", "is 2 enough?", "what if my wife takes two?"
      new RegExp(String.raw`\b${BARE_COUNT} (?:a|per|each) (?:day|night|time)\b`),
      new RegExp(String.raw`\b${BARE_COUNT}\b.*\b(?:ok|okay|fine|alright|all right|enough|too)\b`),
      new RegExp(String.raw`\btakes? ${BARE_COUNT}\b`),
      /\bdouble (?:up|it)\b/,
      // overdose without "took": "i swallowed 6", "i ate the whole pack"
      /\b(?:swallowed|ate|drank|had) (?:\d+|all|the whole|too)\b/,
      /\bwhole (?:pack|box|bottle|strip)\b/,
      // review round 3: "i had eight", "i popped 5", "i downed the bottle", "i ate a lot of them"
      new RegExp(
        String.raw`\b(?:taken|popped|downed|used|finished|swallowed|ate|drank|had) (?:like |about |around )?(?:${BARE_COUNT}|a bunch|a lot|lots|many|several|some|the (?:whole |entire )?(?:pack|box|bottle|strip))\b`,
      ),
      /\b(?:i've|i have|ive) (?:taken|had|used)\b/,
      // "3x a day?", "3/day?", "3 times daily", "3 daily?"
      new RegExp(String.raw`\b${BARE_COUNT} ?(?:x|times|/) ?(?:a |per )?(?:day|daily|night)\b`),
      new RegExp(String.raw`\b${BARE_COUNT} daily\b`),
      /\b(?:once|twice|thrice) (?:a|per) day\b.*\b(?:ok|okay|fine|enough|too|safe)\b/,
      /\bextra (?:one|dose|pill|tablet)\b/,
      /\b(?:triple|double) (?:up|it|the dose)\b/,
      /\bilang?\b/,
    ],
  ],
  [
    'diagnosis',
    [
      /\bdo (?:i|you think i) have\b/,
      /\bdiagnos/,
      /\bsymptoms?\b/,
      /\bwhat(?:'s| is) wrong with\b/,
      /\b(?:cure|treat|heal|fix|work for|good for|help with|help my)\b.*\bmy\b/,
      /\bmy (?:fever|headache|pain|cough|cold|flu|rash|infection|stomach|tummy|throat|condition|illness|disease)\b/,
      /\bi (?:feel|felt|am feeling|have been feeling)\b/,
      /\bi (?:have|got) (?:a |an )?(?:fever|headache|pain|cough|cold|flu|rash|infection|diarrh\w*|sore)\b/,
      /\bam i (?:sick|ill)\b/,
    ],
  ],
  [
    'personal_safety',
    [
      /\bsafe\b/,
      /\b(?:dangerous|harmful|risky)\b/,
      /\ballerg/,
      /\bside effects?\b.*\b(?:i|me|my)\b/,
      /\b(?:i|me|my)\b.*\bside effects?\b/,
      // "can my husband take", "should she use", "can diabetics take"
      new RegExp(
        String.raw`\b(?:can|could|should|may|must) ${SUBJECT} (?:still )?(?:take|use|have|drink|swallow|give)\b`,
      ),
      /\bshould i (?:be worried|worry)\b/,
      /\b(?:can|could|should|may) (?:it|this|these|they|i|we) be (?:taken|used|given)\b/,
      /\b(?:fine|ok|okay|alright|all right|good) (?:for me|for us|with my)\b/,
      new RegExp(String.raw`\b${CONDITION}`),
      /\b(?:is|are) (?:it|this|these|they) (?:ok|okay|alright|all right|fine) (?:for|to)\b/,
      /\bwill (?:it|this) (?:hurt|harm|affect) me\b/,
      /\bstill (?:take|use)\b/,
      // "is it suitable for me?", "would my mom be okay taking this?", "is this for my dad too?"
      /\bsuitable\b/,
      /\b(?:be )?(?:ok|okay|fine|alright) (?:taking|to take|using|for (?:him|her|them|my \w+))\b/,
      /\bfor my \w+\b/,
      // review round 3: "is it appropriate for me?", "is this meant for adults like me?"
      /\b(?:appropriate|right|meant|safe) for (?:me|us|him|her|them|someone|adults like me)\b/,
      /\blike me\b/,
      /\bpwede ba\b/,
    ],
  ],
];

/** Who consumed it: someone other than the asker, or nobody named. */
const CONSUMER = String.raw`(?:he|she|they|we|you|someone|somebody|anyone|my \w+|his \w+|her \w+|their \w+|the \w+)`;
/** A past-tense consumption verb; photo and purchase verbs are not consumption. */
const CONSUMED_VERB = String.raw`(?!(?:printed|photographed|scanned|checked|opened|bought|purchased|found|received|read|showed|shown|uploaded|sent|stored|kept|labeled|labelled|listed|marked|stamped|attached|included|supplied|manufactured|packed|packaged|registered|verified|expired|dated|needed|wanted|dropped|lost|threw|saw|got|left|placed|stated|said|mentioned|called|named|asked|answered|explained)\b)(?:\w+ed|took|ate|drank|downed|swallowed|had)`;
/** What was consumed: a pronoun, "all", or a container or dosage form. */
const CONSUMED_OBJECT = String.raw`(?:it|them|all|everything|(?:all of |all the |half the |the rest of the |the whole |the entire |the |a |an |my |his |her |their )+(?:\w+ )?(?:lot|bottles?|packs?|box(?:es)?|strips?|blisters?|packets?|jars?|tubs?|sachets?|syrups?|tablets?|pills?|capsules?|caplets?|tabs|caps|doses?|medicines?|meds|liquid|suspension|drops|spoonfuls?|teaspoons?|contents))\b`;

/**
 * Structural gate, checked after the named refusal lists (review round 4).
 * Instead of listing dosing phrasings one at a time, any question carrying a
 * quantity, frequency or administration token refuses as personal_dose,
 * whatever its verb. A token inside a printed instruction ("what does 'do not
 * crush' mean?") also refuses: over-refusal is the accepted direction.
 */
const QUANTITY_TOKENS: readonly RegExp[] = [
  // a count: digits that are not a strength ("500 mg"), a registration
  // number ("DR-12345"), a date ("12/2027") or a year ("2027")
  /(?<![\w./-])(?!(?:19|20)\d\d\b)\d+(?:\.\d+)?(?![\w/-]|\.\d| ?(?:mg|mcg|[µμ]g|g|ml|iu|units?)\b| ?%)/,
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|couple)\b/,
  // "one", but not "this one" / "which one"
  /(?<!\b(?:this|that|which|the|each|any|every|no|some|other|first|last) )\bone\b/,
  /\ba few\b/,
  /\bhandfuls?\b/,
  /\bbunch\b/,
  /\b(?:a lot|lots|several|plenty|loads)\b/,
  // "more", but not "tell me more" / "more about" / "more slowly"
  /(?<!\b(?:tell (?:me|us)|say|explain|read) (?:a bit |a little |some )?)\bmore\b(?! (?:about|info|information|details?|clearly|slowly|simply|simple|loudly)\b)/,
  /\banother\b/,
  /\bextra\b(?! strength)/,
  /\bsecond\b(?! (?:line|word|page|side|part|paragraph|panel|row|sentence|item|name|photo|picture|image|label|half)\b)/,
  // "again", but not "read it again" / "say that again"
  /(?<!\b(?:read|say|repeat that|explain|tell|speak|said|play|hear|listen)\b.*)\bagain\b/,
  /\bevery (?:\w+ )?(?:hours?|hrs?|day|night|morning|evening|meal)\b/,
  /\b(?:hourly|daily|nightly|weekly)\b/,
  // times of day: "morning and night?", "bedtime too?"
  /\b(?:mornings?|nights?|tonight|bedtime|evenings?|noon|midday|midnight)\b/,
  /\bin (?:a|one|the same) day\b/,
  /\b(?:a|per|each) (?:day|night|hour)\b/,
  /\b(?:once|twice|thrice)\b/,
  // "half", but not "the bottom half" / "half of the label"
  /(?<!\b(?:top|bottom|left|right|upper|lower|other|first|second|back|front) )\b(?:half|halves)\b(?! of the (?:label|pack|box|photo|picture|image|text|page))/,
  /\b(?:split|splits|splitting|crush|crushes|crushed|crushing|chew|chews|chewed|chewing|break|breaking)\b/,
  /\bcut(?:ting)?\b(?! off)/,
  // double / triple / quadruple and inflections, but not "double check"
  /\b(?:doubl|tripl|quadrupl)(?:e|es|ed|ing)\b(?![ -]check)/,
  // first-person consumption of a whole container with any verb ("i chugged the bottle")
  /\bi (?!(?:opened|bought|purchased|photographed|scanned|checked|found|received|got|have|see|saw|read|want|need|hold|held|keep|kept|lost|dropped|threw|open|am)\b)\w+(?: down| through| off)? (?:the |a |an |my |all |all of |half |half of )*(?:whole |entire |full |rest of the )?(?:bottle|pack|box|strip|blister|packet|jar|tub|sachets?)\b/,
  // review round 5 (c): past-tense consumption with a third-person subject or
  // none ("he gobbled the bottle", "chugged it", "downed the lot")
  new RegExp(
    String.raw`(?:^|\b${CONSUMER} )${CONSUMED_VERB}(?: down| through| off| back)? ${CONSUMED_OBJECT}`,
  ),
  // review round 5 (b): glued counts and clinical abbreviations
  // ("2x", "2tabs", "every 4h", "x2", "q6h", "bid", "prn")
  /\b\d+(?:\.\d+)? ?(?:x|tabs?|caps?|h|hrs?|pcs?)\b/,
  /(?<![\w-])x ?\d+\b/,
  /\bq ?\d+ ?(?:h|hrs?|hours?)\b/,
  /\b(?:bid|tid|qid|prn|qds|tds|qhs)\b/,
  // administration and timing: "a quarter?", "dissolve it?", "with food?", "before sleep?"
  /\bquarters?\b/,
  /\b(?:dissolv|sprinkl)\w*/,
  /\bopen\w*\b.*\b(?:capsules?|caps)\b|\b(?:capsules?|caps)\b.*\bopen\w*/,
  /\bempty stomach\b/,
  /\bwith (?:food|meals?|a meal|milk|water|juice)\b/,
  /\b(?:before|after) (?:eating|meals?|food|sleep\w*|bed|breakfast|lunch|dinner|supper)\b/,
  // duration and continuation: "for how long?", "a week?", "continue?", "keep going?"
  /\bfor how long\b/,
  /\bhow long (?:should|can|must|do|to)\b/,
  /\b(?:a|one|per|each|for a|whole|entire) (?:weeks?|months?|fortnights?)\b/,
  /\bcontinu\w*/,
  /\b(?:keep|kept|keeps) (?:going|on)\b|\bcarry on\b/,
  // measures and schedules: "a spoonful?", "alternate days?", "monthly?"
  /\b(?:spoon\w*|teaspoon\w*|tablespoon\w*|tsp|tbsp|capful\w*|cupful\w*|dropper\w*)\b/,
  /\b(?:monthly|alternate|every other)\b/,
  // the whole question is an amount: "5ml?", "10 mg?"
  /^\d+(?:\.\d+)? ?(?:ml|cc|mg|mcg|g)\W*$/,
];

/**
 * A personal subject (first person, third person or a caregiver's charge)
 * makes the question about someone's own use. Such a question refuses by
 * default, whatever its verb ("could i up it?", "can my body handle it?", "is
 * it strong enough for her?"); only the explicit label-reading and request
 * forms below let it through.
 */
const PERSONAL_SUBJECT =
  /\b(?:i|me|my|myself|mine|im|ive|id|we|us|our|he|she|they|him|her|them|his|their|someone|somebody|kids?|child|baby|son|daughter)\b/;
/** Suitability words: with a first-person subject these refuse even inside a label-reading form. */
const SUITABILITY =
  /\b(?:works?|working|worked|good|better|best|bad|worse|safe|safer|appropriate|meant|suitable|helps?|need|needs|enough|handle)\b|\bright\b(?! (?:side|corner|edge|hand|part|panel|of)\b)/;
/** "should i", "can we", "do i": a first-person modal question asks what to do. */
const MODAL_SUBJECT =
  /\b(?:can|could|should|would|may|might|must|shall|do|did|will|am|is it ok if) (?:i|we)\b(?! (?:hear|see|read|listen|know what (?:it|the \w+) says)\b)/;
/** Medicine-use verbs: a request form does not rescue these; only a label-reading form does. */
const USE_VERB =
  /\b(?:take|takes|taking|took|use|uses|using|drink|drinking|swallow|swallowing|eat|eating|give|giving|apply|applying)\b|\bhave (?:it|this|one|these|them|some)\b/;
/** Explicit label-reading forms: asking what the pack says, not what to do. */
const LABEL_READING: readonly RegExp[] = [
  /\bwhat (?:does|do|did|is|was)\b.*\b(?:say|says|said|mean|means|printed|written)\b/,
  /\b(?:can|could|would|will|please) (?:you )?read\b/,
  /\bread (?:me |out |aloud |back )?(?:the|this|that|what|it)\b/,
  /\b(?:printed|written) (?:on|in|about)\b/,
  /\baccording to the (?:label|pack|box|directions|instructions|leaflet)\b/,
];
/** Request and photo forms that carry a first-person word but ask nothing about use. */
const REQUEST_FORMS: readonly RegExp[] = [
  /\b(?:tell|show|give) (?:me|us)\b/,
  /\b(?:can|could|may) (?:i|we) (?:hear|see|read|listen|know what (?:it|the \w+) says)\b/,
  /\bi (?:can't|cant|cannot|can not|couldn't|couldnt) (?:see|read|find|make out|hear)\b/,
  /\bi (?:took|sent|uploaded|scanned|have) (?:a|the|this|another|my) (?:photos?|pictures?|pics?|images?|scans?)\b/,
];

/**
 * Review round 5 (a): talk of a dose or of changing one ("up the dose?",
 * "redose?", "repeat?", "skipped a dose") refuses as personal_dose unless the
 * question is an explicit label-reading form ("what does the label say about
 * the dose?").
 */
const DOSE_TALK: readonly RegExp[] = [
  // a dose lexeme, but not the label term "dosage form"
  /\b(?:dose|doses|dosage|dosages|dosing|redos\w*|re-dos\w*|overdos\w*)\b(?! forms?\b)/,
  /\b(?:increas\w*|rais(?:e|es|ed|ing)|reduc\w*|repeated|repeating|repeats|retak\w*|retook|re-tak\w*|skip\w*|missed)\b/,
  // "repeat", but not "can you repeat that?" / "please repeat the warning"
  /(?<!\b(?:you|please) )\brepeat\b(?! (?:that|this|what|it back|the (?:last|warnings?|directions|label|text|name|answer))\b)/,
  /\btop(?:s|ped|ping)? (?:it |them |me |him |her )?up\b/,
  /\b(?:lessen\w*|halv\w*|less|fewer|decreas\w*|cut (?:back|down))\b/,
  // comparatives, but not "the lower half" / "bigger text"
  /\b(?:bigger|higher|stronger|lower|larger|smaller|weaker)\b(?! (?:half|part|side|corner|edge|line|section|panel|left|right|text|font|print|letters|photo|picture|image)\b)/,
  // "up" as a verb ("up the dose?", "could i up it?"), but not "look it up" / "up to date"
  /(?<!\b(?:look|looks|looking|looked|pick|picked|show|shows|showed|come|comes|came|set|sum|speak|turn|turned|bring|open|opened|end|ended|it|them|that|this|pull|pulled|make|made|mix|mixed|mess|messed|zoom|zoomed|scroll|scrolled|line|lined|fill|filled|follow|followed|shake|shook|wake|woke|get|got|catch|hold|held|speed|back|move|moved|go|goes|went|scan|scanned) )\bup\b(?! to date\b)/,
];

/** Asking for advice or what the assistant itself would do; checked on every question. */
const ADVICE_REQUEST: readonly RegExp[] = [
  /\b(?:is|are) (?:this|it|these|they) (?:\w+ )?for (?:me|us)\b/,
  /\b(?:recommend|advise|advice|suggest)\w*/,
  // review round 5 (d): "would you take this?", "what would you do?", "if you were me?"
  /\b(?:would|should|will|did|could) you (?:take|use|give|do|try|buy|choose|pick)\b/,
  /\bif you were (?:me|him|her|them|us)\b/,
  /\bought\b/,
  // use after expiry or over time: "still good after expiry?", "still ok?"
  /\bstill (?:ok|okay|good|fine|safe|usable|alright|effective|work\w*)\b/,
];

/** Words that make a question about the pack, the photo or the registry, not about use. */
const LABEL_NOUN =
  /\b(?:label|labels|pack|packs|box|text|printed|written|print|say|says|said|mean|means|meaning|photo|picture|image|font|letters|fda|registry|registered|registration|brand|name|generic|expiry|expir\w*|manufacturer|batch|lot)\b/;
/** Elliptical timing with no label noun: "take it now?", "today?", "right away?". */
const TIMING =
  /\b(?:food|meals?|stomach|now|later|today|tomorrow|yesterday|right away|immediately|asap|overnight|soon)\b/;
/**
 * A medicine-use verb outside a label-reading form asks how or whether to use
 * it ("chug it?", "eat first?", "can a dog have it?"), whoever the subject.
 * "used" is left out so "what is it used for?" stays a label question.
 */
const ANY_USE_VERB =
  /\b(?:take|takes|taking|took|use|uses|using|drink|drinks|drinking|swallow\w*|chew\w*|chug\w*|gulp\w*|eat|eats|eating|give|gives|giving|apply|applying)\b(?! (?:me|us)\b)|\bhave (?:it|this|one|these|them|some|more|another)\b/;
/** Suitability, comparison and effect words with no label noun: "strong enough?", "which is better?". */
const SUITABILITY_WORD =
  /\b(?:strong|stronger|effective|effectiveness|worth|works?|good|better|best|bad|worse|kick in|pets?|dogs?|cats?|animals?|driv\w*|machinery)\b/;
/**
 * Review round 5 (d): yes/no suitability with no subject ("will this work?",
 * "is it enough?", "too strong?"). Refuses only when no label noun is present.
 */
const SUITABILITY_QUESTION: readonly RegExp[] = [
  /\b(?:will|would|does|do|did|is|are|was|can|could|should|might|may) (?:this|it|these|they|that)(?: (?:really|still|even|actually|definitely))? (?:work|works|help|helps|right|the right \w+|enough|ok|okay|fine|alright|safe|effective|good|strong enough|necessary|needed|too \w+)\b/,
  /\btoo \w+/,
  // the whole question is a verdict word: "ok?", "fine?", "is it safe?"
  /^(?:(?:is|are) (?:it|this|that|they) )?(?:ok|okay|fine|alright|good|bad|safe|right|enough)\W*$/,
  // "is it for headaches?", but not "what is it for?"
  /\b(?:is|are) (?:this|it|these|they|that) (?:\w+ )?for (?!what\b)\w+/,
];

function structuralRefusal(text: string): RefusalReason | null {
  if (QUANTITY_TOKENS.some((p) => p.test(text))) return 'personal_dose';
  if (ADVICE_REQUEST.some((p) => p.test(text))) return 'personal_safety';
  const labelReading = LABEL_READING.some((p) => p.test(text));
  if (!labelReading && DOSE_TALK.some((p) => p.test(text))) return 'personal_dose';
  if (!LABEL_NOUN.test(text)) {
    if (TIMING.test(text)) return 'personal_dose';
    if (SUITABILITY_QUESTION.some((p) => p.test(text)) || SUITABILITY_WORD.test(text))
      return 'personal_safety';
  }
  if (!labelReading && ANY_USE_VERB.test(text)) return 'personal_safety';
  if (!PERSONAL_SUBJECT.test(text)) return null;
  if (SUITABILITY.test(text) || MODAL_SUBJECT.test(text)) return 'personal_safety';
  if (labelReading) return null;
  if (!USE_VERB.test(text) && REQUEST_FORMS.some((p) => p.test(text))) return null;
  return 'personal_safety';
}

/** Checked in this order after no refusal matched; default `other_label`. */
const INTENTS: readonly [AllowedIntent, readonly RegExp[]][] = [
  [
    'unclear_parts',
    [
      /\bunclear\b/,
      /\bunreadable\b/,
      /\b(?:could|can|did|do)(?:n't| ?not) (?:you )?(?:read|see|make out)\b/,
      /\b(?:could|can|did|do) you not (?:read|see|make out)\b/,
      /\bnot (?:clear|readable|legible)\b/,
      /\b(?:blurry|missing|illegible)\b/,
    ],
  ],
  ['registry', [/\b(?:fda|registry|registered|registration|verified|verify|verification)\b/]],
  ['strength', [/\bstrength\b/, /\bhow strong\b/, /\b(?:mg|mcg|ml|milligrams?|micrograms?)\b/]],
  [
    'explain_text',
    [
      /\bexplain/,
      /\bmeans?\b/,
      /\bmeaning\b/,
      /\bsimpl(?:e|er)\b/,
      /\bin other words\b/,
      /\b(?:warnings?|directions?|instructions?|storage|store|caution|precautions?)\b/,
    ],
  ],
  [
    'read_label',
    [
      /\bread\b/,
      /\blabel\b/,
      /\b(?:printed|written)\b/,
      /\b(?:name|brand|generic|expiry|expiration|expires?|batch|lot)\b/,
    ],
  ],
];

function normalise(q: string): string {
  return q
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‛′`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyQuestion(q: string): QuestionClass {
  const text = normalise(q);
  for (const [reason, patterns] of REFUSALS) {
    if (patterns.some((p) => p.test(text))) return { allowed: false, reason };
  }
  const structural = structuralRefusal(text);
  if (structural !== null) return { allowed: false, reason: structural };
  for (const [intent, patterns] of INTENTS) {
    if (patterns.some((p) => p.test(text))) return { allowed: true, intent };
  }
  return { allowed: true, intent: 'other_label' };
}
