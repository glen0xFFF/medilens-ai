/**
 * Deterministic question safety gate (spec §4.3 step 1). Runs before any
 * model call. DEFAULT-DENY (Task 5b controller ruling):
 *
 * 1. Normalise (NFKC, strip invisible format characters, lowercase, quotes,
 *    whitespace, trailing punctuation); an empty question or one over 300
 *    characters is refused as outside_label.
 * 2. Refusal patterns run first and win, even inside a label-reading form:
 *    possible overdose, then the named refusal lists, then the structural
 *    gate, then modal dose talk about any person ("should she redose?").
 * 3. English only: a question with any character outside printable ASCII left
 *    after normalisation (a Cyrillic look-alike, an emoji) is refused as
 *    outside_label. This runs after the refusals so the emergency text is
 *    never lost to it.
 * 4. A question is allowed ONLY when the whole normalised question matches one
 *    of the anchored allow templates below (questions about printed content).
 * 5. Everything else is refused as outside_label.
 *
 * Over-refusal of free-typed questions is accepted: the mobile app offers
 * ALLOWED_QUESTION_EXAMPLES as buttons. An under-refusal could be dosing advice.
 */

export type RefusalReason =
  | 'personal_dose'
  | 'start_stop'
  | 'diagnosis'
  | 'special_population'
  | 'interaction'
  | 'personal_safety'
  | 'pill_identification'
  | 'possible_overdose'
  | 'outside_label';

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
  possible_overdose:
    'If someone may have taken too much of this medicine, call 911 or go to the nearest emergency room now.',
  outside_label:
    'I can only read and explain what is printed on this label. For questions about whether or how to take it, please ask a pharmacist or your doctor.',
};

/** Canonical preset questions; the mobile app shows these as buttons. Each one is allowed. */
export const ALLOWED_QUESTION_EXAMPLES: string[] = [
  'Can you read this label?',
  'What does this warning mean?',
  'What strength is printed here?',
  'Explain the directions in simpler words.',
  'Which parts were unclear?',
  'What did the FDA registry say?',
  'Who makes this medicine?',
  'What is the expiry date on the pack?',
  'How should it be stored?',
  'Can you repeat that?',
];

/** Longest question the gate considers (spec §5.1 explain body: question ≤ 300 chars). */
const MAX_QUESTION_CHARS = 300;

const PILL = String.raw`(?:pills?|tablets?|capsules?|caplets?|tabs?)`;
/** Who the question is about: me, someone else, or a group ("diabetics"). */
const SUBJECT = String.raw`(?:i|you|he|she|we|they|someone|anyone|my \w+|\w+s)`;
const COUNT = String.raw`(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|half|a)`;
/** A count with no unit ("is 3 a day ok?", "what if she takes two?"); excludes "a". */
const BARE_COUNT = String.raw`(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|half)`;
const AMOUNT_UNIT = String.raw`(?:${PILL}|mg|mcg|ml|g|doses?|teaspoons?|tsp|tablespoons?|tbsp|spoons?|drops?|sachets?)`;
const CONDITION = String.raw`(?:diabet\w*|blood pressure|hypertensi\w*|kidneys?|renal|liver|heart|asthma\w*|ulcers?)`;
const LOOKS = String.raw`(?:white|yellow|pink|blue|red|orange|green|brown|purple|grey|gray|black|round|oval|oblong|small|big|large|tiny|loose|scored|coated|shiny)`;

/**
 * Task 5b: possible overdose, checked before every other refusal so the
 * emergency text wins ("my baby swallowed one, is that ok?" is not a
 * special_population question). Three shapes: someone reports having taken an
 * amount (two or more, too many, a container, all of it); a child got into or
 * swallowed something; overdose, poison or lethality words. Taking exactly one
 * stays a dose question ("i took one, can i take another?").
 */
const COUNT_WORD_2PLUS = String.raw`(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|dozens?|couple|several|many|multiple|lots|loads|heaps|tons)`;
const CONTAINER = String.raw`(?:bottles?|packs?|packets?|box(?:es)?|strips?|blisters?|jars?|tubs?|sachets?|containers?|tubes?|cartons?|vials?|syrups?|contents|supply|lot)`;
const DOSE_FORMS = String.raw`(?:pills|tablets|capsules|caplets|tabs|caps|meds|medicines|doses)`;
/** Things a count can measure that are not medicine: "it took 2 hours", "i had 2 beers". */
const NOT_MEDICINE = String.raw`(?:hours?|hrs?|minutes?|mins?|seconds?|days?|nights?|mornings?|evenings?|afternoons?|weeks?|months?|years?|yrs?|time|beers?|drinks?|glass(?:es)?|cups?|shots?|coffees?|kids?|children|people|persons?|meals?|am|pm|o'?clock|kg|kilos?|lbs?|pounds?|questions?|photos?|pictures?|care|caution|precautions?)`;
/** Review round 1: too much without a count ("one too many", "a double dose", "extra"); not the "extra strength" product. */
const TOO_MUCH = String.raw`(?:one too many\b|(?:an |some |one |1 )?extra\b(?! strength)|(?:a |the |my |his |her |their )?(?:double|triple|quadruple)\b(?![ -]check| strength))`;
/** Review round 3: an intensifier before "too much" ("way too many", "much too much", "a little too much"). */
const INTENSIFIER = String.raw`(?:wa+y+|far|much|a lot|a bit|a little(?: bit)?|a tad|slightly|really|just|so|very|definitely|probably)`;
/**
 * Review round 3: too much or so much, after up to three intensifiers, also
 * repeated or with a comma ("way, way too much", "far far too many", "so
 * many"), or after "one or two" ("one or two too many").
 */
const TOO_OR_SO = String.raw`(?:(?:${INTENSIFIER},? ){0,3}(?:too|so) (?:much|many)|(?:one|1|a|an) (?:or|to) [\w']+ too many)\b`;
/** An amount that may be too much: two or more, too many, a container, all of it. */
const EXCESS = String.raw`(?:(?:like|about|around|maybe|probably|at least|over|more than|almost|nearly|roughly|perhaps) )?(?:(?:[2-9]|[1-9]\d+)(?:\.\d+)?|${COUNT_WORD_2PLUS}\b|a (?:couple|few|bunch|lot|handful|load|ton|heap|fistful|mouthful|dozen)\b|handfuls?\b|bunch(?:es)?\b|${TOO_OR_SO}|${TOO_MUCH}|all\b|(?:them|these|those) all\b|everything\b|(?:the |a |an |my |his |her |their |our )?(?:whole|entire|full|rest of the|remaining) (?:\w+ )?(?:${CONTAINER}|${DOSE_FORMS}|things?)\b|(?:the |a |an |my |his |her |their |our |half (?:the|a|of the) )(?:\w+ )?${CONTAINER}\b)(?! ?(?:of )?${NOT_MEDICINE}\b)`;
/** Past or perfect ingestion verbs, not passive ("can it be taken 2 at a time?", "is it used 3 times a day?"). */
const NOT_PASSIVE = String.raw`(?<!\b(?:be|been|being|is|are|was|were|get|gets|got|to)(?: it| this| that| they| these| those)? )`;
const INGESTED = String.raw`(?:took|taken|swallowed|popped|downed|used|consumed|gobbled|chugged|gulped|guzzled|inhaled|finished|wolfed|scoffed|devoured|chewed|necked|snorted|injected|knocked|polished)`;
/**
 * Food and drink verbs: "too much", "one too many", "extra" or "a double" after
 * these is usually food or alcohol, so only counts and containers count.
 */
const INGESTED_FOOD = String.raw`(?:ate|eaten|drank|drunk|had)`;
const PARTICLE = String.raw`(?: (?:down|back|off|through|up))?`;
/** Review round 1: an age that stands for a person ("my 2 year old", "her 18-month-old", "my 3yo"). */
const AGE = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen)[ -]?(?:(?:years?|yrs?|months?|mos?|weeks?|wks?)[ -]?old|y\.?o\.?)`;
const CHILD = String.raw`(?:kids?|child|children|baby|babies|toddlers?|infants?|newborns?|little ones?|sons?|daughters?|grand(?:son|daughter|child|kid)s?|nephews?|nieces?|anak|bata|sanggol|${AGE})`;
/** Up to three words between the child and the verb: "the baby may have", "is the baby ok if she". */
const CHILD_GAP = String.raw`(?:[\w']+ ){0,3}?`;
/** Review round 2: the -ing forms too ("the baby is chewing on a pill"). */
const CHILD_INGESTED = String.raw`(?:ate|eaten|eating|swallowed|swallowing|drank|drunk|drinking|took|taken|had|popped|chewed|chewing|sucked|sucking|licked|licking|consumed|gulped|guzzled|chugged|gobbled|downed|bit|bitten|biting|tasted|tasting)`;
/** "chewed on the blister", "bit into a tablet", "sucked on a pill". */
const CHILD_PARTICLE = String.raw`(?: (?:down|up|on|at|into|through|off))?`;
/** A dose named with a determiner: "my dose", "his pills", "the evening dose". */
const TAKEN_DOSE = String.raw`(?:my|his|her|their|our|the|a|this|that) (?:\w+ )?(?:dose|doses|${PILL}|medicines?|medications?|meds|syrup)`;
/** What was taken again: "it", "my dose", "his pills". */
const TAKEN_THING = String.raw`(?:it|them|one|${TAKEN_DOSE})`;
/**
 * Review round 1: a whole dose taken again ("twice", "three times"), but not a
 * schedule ("twice a day"). Review round 2: "2x", "x2".
 */
const REPEATED = String.raw`(?:twice|thrice|(?:two|three|four|2|3|4) times|a second time|[2-9] ?x|x ?[2-9])\b(?! ?(?:a|per|each|every) (?:day|night|week|morning|evening)\b| ?(?:daily|nightly|weekly)\b)`;
const CHILD_OBJECT = String.raw`(?:some|one|it|them|all|any|a few|a bunch|a lot|a handful|a couple|several|many|\d+|${COUNT_WORD_2PLUS}|(?:a|an|the|my|his|her|their|our|your)(?: \w+)? (?:pills?|tablets?|capsules?|caplets?|tabs?|caps|medicines?|meds|syrups?|drops|doses?|${CONTAINER}|spoonfuls?|sips?|bites?|bits?|pieces?)|pills?|tablets?|capsules?|caplets?|medicines?|meds|syrup)`;
/**
 * Review round 2: plain food or drink after the child's object ("is drinking
 * some water", "ate some rice") is not medicine. Candy and sweets are left
 * out on purpose: a child may take a pill for one.
 *
 * Review round 3: the food word must END the clause, so "milk of magnesia",
 * "fruit gummies" and "tea with my pills" are not food. What may follow it is
 * the end of the question, or a new clause (FOOD_NEXT: "then went to bed",
 * ", can he take it", ". is that ok"), never a second thing taken ("and some
 * of it", "and half the bottle", "and <a brand name>"). It also fails closed:
 * a medicine word, an ingestion verb or an access verb anywhere later in the
 * question, not only in the same sentence ("ate some fruit. then she took my
 * pills", "then got into my purse"), keeps the emergency text.
 */
const CHILD_FOOD = String.raw`(?:water|juice|milk|formula|food|rice|soup|tea|bread|fruit|cereal|breakfast|lunch|dinner|snacks?|meals?)`;
/** Words that start a new clause after the food word: a modal, a pronoun, a time or a plain verb. */
const FOOD_NEXT = String.raw`(?:can|could|is|was|are|were|should|will|would|did|does|do|may|might|now|today|tonight|earlier|yesterday|this (?:morning|afternoon|evening)|he|she|they|i|we|you|after|before|went|fell|seems?|seemed|looks?|looked|feels?|felt|just|only)\b`;
const FOOD_END = String.raw`(?=[,.?!;]*$|[,.?!;]* (?:(?:and|then|but|so)(?: then)? )?${FOOD_NEXT})`;
/** Used for "both" too: punctuation, the end, or a conjunction or new clause. */
const CLAUSE_END = String.raw`(?:[,.?!;]|$| (?:and|then|but|so|can|could|is|was|should|will|would|now|today)\b)`;
const MEDICINE_WORD = String.raw`\b(?:pills?|tablets?|tabs?|capsules?|caps|caplets?|syrups?|medic\w*|meds|gumm\w*|vitamins?|magnesia|chewables?|doses?|dosage|drops|drugs?|lozenges?|sachets?|supplements?|paracetamol|acetaminophen|ibuprofen|aspirin|antibiotics?|ointment|cream)\b`;
/** Review round 3: a child reaching medicine; after a food word it keeps the emergency text. */
const CHILD_ACCESS = String.raw`(?:got into|gotten into|got in to|got (?:a )?hold of|got ahold of|got at|grabbed|found|opened|reached)`;
const NOT_CHILD_FOOD = String.raw`(?! (?:of )?(?:the |his |her |their |my |your |a |an |some )?(?:(?!${MEDICINE_WORD})\w+ )?${CHILD_FOOD}${FOOD_END}(?!.*(?:${MEDICINE_WORD}|\b(?:${CHILD_INGESTED}|${CHILD_ACCESS})\b)))`;
/**
 * Review round 3: what a child put in the mouth, also "one of my pills", "some
 * of grandma's tablets", "one of those", "a couple of them", "something",
 * and a count before the noun ("some pills", "two tablets").
 */
const MOUTH_OBJECT = String.raw`(?:${CHILD_OBJECT}|something|(?:some|any|a few|a couple(?: of)?|several|many|${COUNT_WORD_2PLUS}|\d+) (?:[\w']+ )?(?:pills?|tablets?|capsules?|caplets?|tabs?|caps|medicines?|meds|vitamins?|gummies)|(?:one|some|any|a few|a couple|several|half|${COUNT_WORD_2PLUS}|\d+) of (?:them|these|those|it|mine|his|hers|theirs|ours|yours|(?:(?:the|my|his|her|their|your|our|these|those) )?(?:[\w']+ ){0,2}?(?:pills?|tablets?|capsules?|caplets?|tabs?|caps|medicines?|medications?|meds|vitamins?|gummies)))`;
/** "with": "i found the baby with a pill in his mouth". */
const MOUTH_VERB = String.raw`(?:put|puts|putting|stuck|sticks?|sticking|popped|popping|placed|placing|shoved|shoving|stuffed|stuffing|had|has|having|got|holding|held|with)`;
/** Review round 3: a child as a possessive ("the baby's got", "my son's chewing"). */
const CHILD_S = String.raw`${CHILD}(?:'s)?`;
/**
 * Review round 2: more than the label, a prescriber or the person allows
 * ("more than the label says", "more than recommended", "more than the usual
 * dose", "more than i should have"), or more than one, but not a time ("it
 * took more than one day"). MORE_PREFIX is what may stand between the verb and
 * "more": "one more", "way more", "a bit more".
 */
const MORE_PREFIX = String.raw`(?: (?:${TAKEN_THING}|1|a (?:few|couple|lot|bit|little)|some|way|much|far|slightly|lots|loads|many))?`;
/** Review round 3: what was taken, between "more" and "than" ("more pills than", "more of it than"). */
const MORE_DOSE_NOUN = String.raw`(?:${PILL}|caps|medicines?|medications?|meds|syrups?|doses?|drops|gummies|vitamins?)`;
/** A named dose after "more": "of my pills", or a dose noun with one optional word ("sleeping pills"). */
const MORE_DOSE = String.raw`(?: (?:of (?:the|my|his|her|their|our|your|these|those|this|that) (?:\w+ )?${MORE_DOSE_NOUN}|(?:\w+ )?${MORE_DOSE_NOUN}))`;
/**
 * After an ingestion verb any up to four words may stand between "more" and
 * "than" ("more of it", "more of this medicine", "more <a generic name>"),
 * except a time or a photo ("i took more photos than i should").
 */
const MORE_NOUN = String.raw`(?: (?!than\b|${NOT_MEDICINE}\b)[\w']+){0,4}?`;
/** Review round 3: "than what the label says", "than what's recommended", "than is recommended". */
const THAN_WHAT = String.raw`(?:what(?:'s|s| is| was)? |(?:is|was) )?`;
/** Review round 3: "more than twice the dose", "more than double". */
const THAN_MULTIPLE = String.raw`(?:twice|double|triple|thrice)\b`;
const LABEL_VERB = String.raw`(?:says?|said|recommends?|recommended|allows?|allowed|states?|stated|directs?|directed|tells?|told|prescribes?|prescribed|advises?|advised|instructs?|instructed|suggests?|suggested|indicates?|indicated|ordered)`;
const THAN_LABEL = String.raw`(?:(?:it|(?:the|its|my|his|her|their|our) (?:doctor|doc|pharmacist|physician|nurse)) ${LABEL_VERB}|(?:the|its|my|his|her|their|our) (?:label|pack|box|bottle|leaflet|insert|directions?|instructions?|prescription)(?: ${LABEL_VERB})?|(?:printed |written |stated )?(?:on|in) (?:the|its|my|his|her|their) (?:label|pack|box|bottle|leaflet|insert|directions|instructions|prescription)|recommended|directed|prescribed|allowed|advised|instructed|indicated|stated|printed|written|(?:the |its |my |his |her |their |our |a )?(?:(?:recommended|usual|normal|maximum|max|single|stated|printed|prescribed|daily) ){0,2}(?:dose|doses|dosage|amount)|(?:the |its )?(?:daily |recommended )?(?:maximum|max|limit))\b`;
/** Not after a food or drink verb: "i ate more than usual" is food. */
const THAN_USUAL = String.raw`(?:usual|normal|normally|usually|(?:one|1)(?! (?:of )?${NOT_MEDICINE}\b))\b`;
/** Review round 3: also "than i could handle", "than i can", "than i normally do", "than i did". */
const THAN_PERSON = String.raw`(?:i|im|you|youre|he|hes|she|shes|they|theyre|we)(?:'d|'m|'re|'s)? (?:should|shouldve|should've|ought|was|were|am|are|is|meant|supposed|allowed|told|advised|needed|need|wanted|had to|have to|has to|could|can|cant|can't|would|intended|planned|normally|usually|ever|did|do|does)\b`;
/** "it took more than usual to work" is a time, not a dose. */
const NOT_IT = String.raw`(?<!\b(?:it|that|this|which) )`;
/**
 * Review round 2: "both doses", "both of the tablets", "both my pills". Review
 * round 3: up to four words before the noun ("both my morning and evening
 * dose") and medicines ("both of my meds").
 */
const BOTH = String.raw`both (?:of )?(?:the |my |his |her |their |our |these |those )?(?:[\w']+ ){0,4}?(?:doses?|pills?|tablets?|capsules?|caplets?|tabs|caps|medicines?|medications?|meds)\b`;
/**
 * Review round 3: "both of them", "them both", a bare "both" at the end of a
 * clause or with "at once", "together", "at the same time"; after a food verb
 * this is usually food, so not there.
 */
const BOTH_THEM = String.raw`(?:both(?: of)? (?:them|these|those)\b|(?:them|these|those) both\b|both\b(?=${CLAUSE_END}| (?:at once|at the same time|together|in one go|one after the other)\b))`;
/**
 * Review round 3: over a limit ("i exceeded the dose", "i took over the
 * limit", "she went over the maximum"), but not "the maximum temperature" or
 * "went over the dosage instructions".
 */
const LIMIT_ADJ = String.raw`(?:recommended|daily|maximum|max|stated|prescribed|usual|normal|safe|printed|single|allowed|permitted)`;
/** Review round 3: an amount before the limit ("the 4g limit", "the 4000 mg daily limit", "the 8 tablet limit"). */
const LIMIT_MOD = String.raw`(?:${LIMIT_ADJ}|\d+(?:\.\d+)? ?(?:mg|mcg|g|grams?|ml)?|mg|mcg|g|grams?|ml|${PILL}|doses?|dosage)`;
const LIMIT_NOUN = String.raw`(?:dose|doses|dosage|amount|limit|max(?:imum)?)\b(?! (?:temperature|temp|storage|heat|humidity|shelf|instructions?|directions?|info\w*|sections?|chart|table|guide|label|details?|with|again)\b)`;
/** Review round 3: "way over", "well above", "a bit over". */
const OVER_ADV = String.raw`(?:(?:way|well|far|much|a bit|a little|slightly|just|probably|definitely|already|now|really) )*`;
const OVER = String.raw`${OVER_ADV}(?:over|above|beyond|past)`;
/** Review round 3: being over a limit ("i'm over the daily limit", "she is way over the max"). */
const BE_PERSON = String.raw`(?:i'm|im|i am|i've been|ive been|i was|he's|hes|he is|he was|she's|shes|she is|she was|we're|we are|we were|they're|theyre|they are|they were)`;
const OVER_LIMIT = String.raw`(?:exceeded|surpassed|overshot|passed|(?:took|taken|went|gone|used) ${OVER}|${BE_PERSON} ${OVER}|did (?:i|we|he|she|they|someone|(?:my|his|her|their|the) \w+) (?:exceed|overshoot|pass|go ${OVER}))(?: (?:the|my|his|her|their|its|our|a))?(?: ${LIMIT_MOD}){0,3} ${LIMIT_NOUN}`;
/** Review round 2: one more dose ("another one", "a second dose"); after a food verb the noun is required. */
const ANOTHER = String.raw`(?:another|a second|a 2nd|an additional|one more|1 more|an extra)`;
const EXTRA_DOSE_NOUN = String.raw`(?:one|dose|${PILL}|spoonful|teaspoon|sachet)`;
/** Not "another photo" or "another picture": NOT_MEDICINE after the bare form. */
const TOOK_ANOTHER = String.raw`(?:${INGESTED}${PARTICLE} ${ANOTHER}(?: ${EXTRA_DOSE_NOUN})?|${INGESTED_FOOD} ${ANOTHER} ${EXTRA_DOSE_NOUN})\b(?! ${NOT_MEDICINE}\b)`;
const BY_MISTAKE = String.raw`(?:by (?:mistake|accident)|accidentally|mistakenly|in error|unintentionally|without thinking)`;

const POSSIBLE_OVERDOSE: readonly RegExp[] = [
  // "i swallowed 6 of these", "she has taken too many", "i took the whole pack"
  new RegExp(String.raw`${NOT_PASSIVE}\b${INGESTED}${PARTICLE} ${EXCESS}`),
  new RegExp(
    String.raw`${NOT_PASSIVE}\b${INGESTED_FOOD}${PARTICLE} (?!(?:${INTENSIFIER},? ){0,3}(?:too|so) much\b|${TOO_MUCH})${EXCESS}`,
  ),
  // "i had a double dose": a dose word after a food verb is not food
  new RegExp(
    String.raw`${NOT_PASSIVE}\b${INGESTED_FOOD} ${TOO_MUCH} (?:\w+ )?(?:doses?|${PILL}|medicines?|meds)\b`,
  ),
  // "i took it twice", "he took his pills twice today", "i had my dose twice"
  new RegExp(String.raw`${NOT_PASSIVE}\b${INGESTED}${PARTICLE}(?: ${TAKEN_THING})? ${REPEATED}`),
  new RegExp(String.raw`${NOT_PASSIVE}\b${INGESTED_FOOD} ${TAKEN_THING} ${REPEATED}`),
  // review round 2: "i took more than the label says", "i took one more than i
  // should"; review round 3: "i took more pills than i should", "more of it
  // than", "more than what the label says", "more than twice the dose"
  new RegExp(
    String.raw`${NOT_PASSIVE}${NOT_IT}\b${INGESTED}${PARTICLE}${MORE_PREFIX} more${MORE_NOUN} than (?:${THAN_WHAT}${THAN_LABEL}|${THAN_USUAL}|${THAN_WHAT}${THAN_PERSON}|${THAN_MULTIPLE}|enough\b)`,
  ),
  // after a food or drink verb only the label form: "i had more than the
  // recommended dose", but not "i ate more than usual" or "...than i should"
  new RegExp(
    String.raw`${NOT_PASSIVE}${NOT_IT}\b${INGESTED_FOOD}${MORE_PREFIX} more than ${THAN_WHAT}${THAN_LABEL}`,
  ),
  // review round 3: with a dose noun a food verb is not food ("i had more pills than i should")
  new RegExp(
    String.raw`${NOT_PASSIVE}${NOT_IT}\b${INGESTED_FOOD}${MORE_PREFIX} more${MORE_DOSE} than (?:${THAN_WHAT}${THAN_LABEL}|${THAN_USUAL}|${THAN_WHAT}${THAN_PERSON}|${THAN_MULTIPLE})`,
  ),
  // review round 3: "i exceeded the dose", "i took over the limit", "she went over the maximum"
  new RegExp(String.raw`${NOT_IT}\b${OVER_LIMIT}`),
  // review round 3: asking whether too much was taken ("did i take too much?",
  // "did she take more than the label says?")
  new RegExp(
    String.raw`\bdid (?:i|we|he|she|they|someone|somebody|(?:my|his|her|their|the) \w+) (?:take|swallow|use|eat|drink|have)(?: (?:it|them|one|${TAKEN_DOSE}))? (?:${TOO_OR_SO}|${TOO_MUCH}|more than)`,
  ),
  // review round 3: "i exceeded it", "she overshot that"
  new RegExp(String.raw`${NOT_IT}\b(?:exceeded|surpassed|overshot) (?:it|that|them)\b`),
  // "i took both doses", "she took both of the tablets"
  new RegExp(String.raw`${NOT_PASSIVE}\b(?:${INGESTED}|${INGESTED_FOOD})${PARTICLE} ${BOTH}`),
  // review round 3: "i took both of them", "i took them both by accident", "i took both by mistake"
  new RegExp(String.raw`${NOT_PASSIVE}\b${INGESTED}${PARTICLE} ${BOTH_THEM}`),
  new RegExp(
    String.raw`${NOT_PASSIVE}\b${INGESTED}${PARTICLE} both (?:[\w']+ ){0,3}?${BY_MISTAKE}\b`,
  ),
  // one more dose by mistake: "i took another one by mistake", "i
  // accidentally took a second dose", "by mistake, i took another"
  new RegExp(String.raw`${NOT_PASSIVE}\b${TOOK_ANOTHER} (?:[\w']+ ){0,3}?${BY_MISTAKE}\b`),
  new RegExp(String.raw`\b${BY_MISTAKE},? (?:[\w']+ ){0,3}?${TOOK_ANOTHER}`),
  // a dose taken again: "i took my morning dose again", "i forgot and took it
  // again". Decision: no exclusion, not even "as directed"; the emergency text
  // is conditional, so over-triage is the accepted direction.
  new RegExp(String.raw`${NOT_PASSIVE}\b${INGESTED}${PARTICLE}(?: ${TAKEN_THING})? again\b`),
  new RegExp(String.raw`${NOT_PASSIVE}\b${INGESTED_FOOD} ${TAKEN_DOSE} again\b`),
  // "chugged it", "gobbled them", "downed everything"
  /\b(?:chugged|gobbled|downed|guzzled|wolfed|necked|scoffed|devoured|knocked back|polished off)(?: down| back| off)? (?:it|them|all|everything)\b/,
  // "i doubled my dose", "she od'd", "i might have overdone it"
  /\b(?:doubled|tripled|quadrupled|double[- ]?dosed|overdid|overdone|overdoing|od'?d|oded)\b/,
  // a child got into it, got some, or swallowed something
  new RegExp(
    String.raw`\b${CHILD_S} ${CHILD_GAP}(?:got into|gotten into|got in to|got (?:a )?hold of|got ahold of|got at|got to|got (?:some|one|it|them)|grabbed|found|opened|reached)\b`,
  ),
  new RegExp(
    String.raw`\b${CHILD_S} ${CHILD_GAP}${CHILD_INGESTED}${CHILD_PARTICLE} ${CHILD_OBJECT}\b${NOT_CHILD_FOOD}`,
  ),
  // review round 2: medicine in a child's mouth ("the baby put one in his
  // mouth", "my toddler has a pill in her mouth"), but not "his hand"; review
  // round 3: "put one of my pills in his mouth", "is putting pills in his
  // mouth", "the baby's got a pill in his mouth", "found the baby with a pill
  // in his mouth"
  new RegExp(
    String.raw`\b${CHILD_S} ${CHILD_GAP}${MOUTH_VERB} ${MOUTH_OBJECT} (?:in|into|inside) (?:his|her|their|its|the|a|my)(?: ${CHILD}'?s)? mouth\b`,
  ),
  // review round 3: "there is a pill in the baby's mouth", but not giving a
  // dose ("how do i put it in my baby's mouth?", "can i put the syrup in ...")
  new RegExp(
    String.raw`(?<!\b(?:put|puts|putting|give|giving|place|placing|squirt|squirting|pour|pouring|drop|dropping|insert|inserting|get|getting|apply|spoon|feed|feeding)(?: (?:the|a|an|this|that|my|his|her|their|some|one|half(?: a| of the)?))? )\b(?:${PILL}|caps|medicines?|medications?|meds|syrup|something|one|some|it|them)\b(?: [\w']+){0,4}? (?:in|into|inside) (?:the |my |our |his |her |their )?${CHILD}'?s mouth\b`,
  ),
  // overdose, poison and lethality words ("he overdosed", "lethal?", "can it kill?")
  /\b(?:overdos\w*|poison\w*|toxic\w*|lethal|fatal|deadly)\b/,
  /\b(?:can|could|will|would|might|may|does|did) (?:it|this|these|they|that|too much|an overdose) kill\b/,
  /\bkill (?:me|you|him|her|them|us|someone|somebody|a (?:person|child|kid|baby))\b/,
  /\b(?:die|dies|died|dying)\b/,
];

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

/**
 * Task 5b: a modal about any person plus dose or use talk refuses even inside a
 * label-reading form, exactly as the first-person form does ("according to the
 * label, should she increase the dose?", "what does it say, can she up it?",
 * "what does it say about how i should take it?"). Runs after the structural
 * gate so the Task 5 reasons of first-person questions are unchanged.
 */
const DOSE_PERSON = String.raw`(?:i|we|he|she|they|someone|somebody|anyone|everyone|people|adults?|patients?|(?:my|his|her|their|our|your|the|a|this|that) (?!(?:label|labels|pack|box|text|photo|picture|image|registry|fda|dose|dosage|medicine|tablets?|capsules?|pills?|syrup|bottle|warnings?|directions|instructions|strength|name|brand)\b)\w+)`;
const MODAL_PERSON: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:can|could|should|would|will|may|might|must|shall|do|does|did|is it (?:ok|okay|fine|alright|safe) (?:if|for)|ok (?:if|for)) ${DOSE_PERSON}\b`,
  ),
  new RegExp(
    String.raw`\b${DOSE_PERSON} (?:can|could|should|would|will|may|might|must|shall|needs? to|ha(?:ve|s) to|ought to|(?:is|are|am) (?:supposed|allowed|meant) to|wants? to)\b`,
  ),
];
const EXTRA_DOSE_VERB = /\b(?:inject\w*|administer\w*|consum\w*|bump\w*|redo\w*)\b/;

function modalDoseRefusal(text: string): RefusalReason | null {
  if (!MODAL_PERSON.some((p) => p.test(text))) return null;
  const doseTalk =
    DOSE_TALK.some((p) => p.test(text)) || ANY_USE_VERB.test(text) || EXTRA_DOSE_VERB.test(text);
  return doseTalk ? 'personal_dose' : null;
}

/*
 * Anchored allow templates (Task 5b). A question is allowed only when the
 * WHOLE normalised question matches one of these; the free slots are narrow
 * (a field name, a section name, a quoted printed phrase or a short phrase
 * with no pronoun, modal or question word).
 */
const ASK = String.raw`(?:please )?(?:(?:can|could|would|will) you (?:please )?)?`;
const PLEASE = String.raw`(?: please)?`;
const PACK = String.raw`(?:label|labels|pack|packet|package|packaging|box|carton|bottle|blister|strip|sachet|leaflet|insert|package insert|tube|container|wrapper)`;
const DET = String.raw`(?:the|this|that|my)`;
const ON_PACK = String.raw`(?: (?:on|in|from) ${DET} ${PACK})?`;
const HERE = String.raw`(?: here| on it)?`;
const ALOUD = String.raw`(?: (?:out loud|aloud|to me|for me))?`;
const SIMPLER = String.raw`(?: (?:in (?:simpler|simple|plain|easier|easy|other|everyday) (?:words|terms|language|english)|more simply|simply))?`;
/** A part of the pack: "the second line", "the lower half of the label", "the right side". */
const REGION = String.raw`(?:top|bottom|left|right|front|back|side|first|second|third|last|next|other|upper|lower|middle)(?: (?:half|part|side|line|panel|section|row|paragraph|word|bit|corner|edge))?(?: of ${DET} ${PACK})?`;
/** Printed sections that are explained rather than read out. */
const SECTION = String.raw`(?:warnings?|cautions?|precautions?|directions?(?: for use)?|instructions?|storage(?: instructions?| conditions?| directions?)?|label text)`;
/** Printed fields that are read out. */
const FIELD = String.raw`(?:brand(?: name)?|generic(?: name)?|name|product name|medicine name|drug name|full name|manufacturer|maker|distributor|importer|ingredients?|active ingredients?|inactive ingredients?|dosage form|form|expiry(?: date)?|expiration(?: date)?|exp date|best before(?: date)?|manufacturing date|date of manufacture|lot(?: number| no)?|batch(?: number| no)?|registration(?: number| no)?|fda registration(?: number| no)?|reg no|dose amount|dosage amount)`;
/** What "what does the label say about ..." may ask about. */
const TOPIC = String.raw`(?:(?:the |its )?(?:${FIELD}|${SECTION}|strength|dose|dosage|dosing|storage)|how (?:often )?to (?:take|use|store) (?:it|this|them)|storing it)`;
/**
 * Words a printed phrase may not contain, quoted or not (review round 1): a
 * pronoun; a modal or auxiliary, also negated without its apostrophe ("dont",
 * "shouldnt"); a question word or conjunction; a verdict, claim or amount word
 * ("fake", "same", "cure", "need", "works", "much"); a person or animal it
 * could be for; a giving or taking verb; and "mean" itself, so that a phrase
 * always ends at the first " mean".
 */
const PHRASE_STOP = String.raw`(?:i|me|my|mine|myself|we|us|our|ours|you|your|yours|he|him|his|she|her|hers|they|them|their|theirs|it|its|this|that|these|those|someone|somebody|anyone|anybody|everyone|everybody|nobody|people|can|could|should|would|will|shall|may|might|must|do|does|did|is|are|am|was|were|be|been|being|have|has|had|(?:do|does|did|is|are|was|were|has|have|had|ca|can|could|would|should|must|need|wo|ai|might|sha)nt|if|when|whenever|whether|how|why|what|which|who|whom|whose|where|and|or|but|so|then|than|because|until|till|ok|okay|yes|no|not|safe|safer|safest|safely|unsafe|harm\w*|fake\w*|counterfeit\w*|genuine\w*|real|really|authentic\w*|legit\w*|same|identical|equivalent\w*|similar|substitut\w*|interchangeab\w*|cur(?:e|es|ed|ing)|need\w*|true|false|fine|good|bad|better|best|worse|worst|wrong|right|enough|effective\w*|work\w*|treat\w*|heal\w*|kill\w*|many|much|more|most|less|fewer|often|freely|unlimited|doctors?|physicians?|pets?|dogs?|cats?|pupp(?:y|ies)|animals?|give\w*|gave|take\w*|took|mean\w*)`;
/**
 * Review round 2: hyphenated or dotted label terms accepted whole. Any other
 * joining character between letters is refused, so a stop word cannot hide
 * behind one ("x-fake", "a.you.can.take.many", "f-a-k-e").
 */
const PHRASE_COMPOUND = String.raw`(?:non-drowsy|sugar-free|sugar-coated|film-coated|enteric-coated|(?:extended|sustained|delayed|modified|controlled|immediate)-release|e\.g|i\.e)`;
/** A number: '.' and '-' only between digits ("0.5", "2-8"), then an optional "%". */
const PHRASE_NUMBER = String.raw`\d+(?:[.-]\d+)*%?`;
/**
 * A word of a printed phrase: a whole label term, a number, or letters and
 * digits that are not a stop word, then an optional period or comma ("keep
 * dry.", "a cool, dry place"); the next word still starts after a space.
 * No quote or apostrophe: a phrase cannot run past its closing quote.
 */
const PHRASE_WORD = String.raw`(?:${PHRASE_COMPOUND}|${PHRASE_NUMBER}|(?!${PHRASE_STOP}\b)[a-z0-9]+)[.,]?`;
/** Longest printed phrase, in characters, that "what does ... mean" accepts. */
const MAX_PHRASE_CHARS = 60;
/**
 * A printed phrase, quoted or not: 1 to 6 words and at most 60 characters. The
 * lookahead finds a quote or " mean" within 60 characters; a phrase can contain
 * neither, so it ends there.
 */
const PHRASE = String.raw`(?=[^"']{1,${MAX_PHRASE_CHARS}}(?:["']| mean\b))${PHRASE_WORD}(?: ${PHRASE_WORD}){0,5}`;
/** A quoted printed phrase: the same grammar as the unquoted one. */
const QUOTED = String.raw`(?:"${PHRASE}"|'${PHRASE}')`;
const UNCLEAR = String.raw`(?:unclear|not clear|unreadable|not readable|hard to read|blurry|blurred|illegible|missing|cut off|uncertain)`;
const PARTS = String.raw`(?:parts?|fields?|bits?|sections?|words?|lines?|details?|things?)`;
const COULD_NOT_YOU = String.raw`(?:(?:couldn't|couldnt|could not|can't|cant|cannot|can not|didn't|didnt|did not|weren't|were not) you|(?:could|can|did|were) you not)`;
const REG = String.raw`(?:fda |ph fda |philippine fda )?(?:registry|register|database|fda|records?)`;
/** Review round 2: a registration number in the registry's own formats only (parsers.ts REG_RE). */
const REG_NO = String.raw`(?:dr-xy|drhr-|drp-|dr-)\d{1,10}`;
const THING = String.raw`(?:it|this|this medicine|the medicine|this product|the product|this drug|this one)`;

const TEMPLATES: readonly [AllowedIntent, string][] = [
  // unclear_parts
  ['unclear_parts', String.raw`(?:which|what) ${PARTS} (?:were|are|was|is) ${UNCLEAR}`],
  [
    'unclear_parts',
    String.raw`(?:which|what) (?:${PARTS} )?${COULD_NOT_YOU} (?:read|see|make out)`,
  ],
  ['unclear_parts', String.raw`what(?:'s| is| was| were| are) ${UNCLEAR}`],
  [
    'unclear_parts',
    String.raw`(?:is|was|are|were) (?:any(?:thing| part| parts| of it)?|something|it|part of ${DET} ${PACK}|(?:the|this) (?:text|label|pack|box|photo|picture|image|print|writing|scan)|the ${REGION}|the ${FIELD}|the strength)(?: on ${DET} ${PACK})? (?:${UNCLEAR}|clear|readable|legible)`,
  ],
  [
    'unclear_parts',
    String.raw`(?:were|are) there any (?:${UNCLEAR} ${PARTS}|${PARTS} (?:that (?:were|are) )?${UNCLEAR})`,
  ],
  [
    'unclear_parts',
    String.raw`how (?:clear|readable|legible) (?:is|was) (?:the (?:photo|picture|image|label|text|scan)|it)`,
  ],
  // registry
  [
    'registry',
    String.raw`what (?:did|does) the ${REG}(?: (?:check|search|lookup|result|record))? (?:say|show|find|return|report)(?: about ${THING})?`,
  ],
  ['registry', String.raw`what did you find in the ${REG}`],
  [
    'registry',
    String.raw`is ${THING} (?:fda[- ])?(?:registered|listed)(?: (?:with|by|in|on) the ${REG})?(?: now)?`,
  ],
  ['registry', String.raw`is ${THING} (?:in|on|listed in|listed on|found in) the ${REG}`],
  [
    'registry',
    String.raw`(?:was|is) ${THING} (?:found|listed|verified|matched|registered) (?:in|by|on|with) the ${REG}`,
  ],
  [
    'registry',
    String.raw`(?:did|does|could|can) (?:the ${REG}|you) (?:find|match|verify|list|have) (?:${THING}|a match)(?: in the ${REG})?`,
  ],
  [
    'registry',
    String.raw`${ASK}(?:check the ${REG}|search the ${REG}|look (?:it|this|this medicine) up in the ${REG}|look up ${THING} in the ${REG})${PLEASE}`,
  ],
  [
    'registry',
    String.raw`is (?:the registration number|the reg no|${REG_NO}) (?:registered|in the ${REG})`,
  ],
  [
    'registry',
    String.raw`what (?:is|was) the (?:registry|fda|verification|match|registration) (?:result|status|outcome)`,
  ],
  // strength
  [
    'strength',
    String.raw`what(?:'s| is) the strength(?: (?:printed|written|shown|stated))?(?: (?:of|for) (?:it|this|this medicine|each (?:tablet|capsule|caplet)))?${ON_PACK}${HERE}`,
  ],
  [
    'strength',
    String.raw`what strength is (?:it|this|this medicine|printed|written|shown|stated|on ${DET} ${PACK})${ON_PACK}${HERE}`,
  ],
  [
    'strength',
    String.raw`how strong is (?:it|this|this medicine|each (?:tablet|capsule|caplet))(?: per (?:tablet|capsule|caplet|ml))? according to ${DET} ${PACK}`,
  ],
  ['strength', String.raw`is (?:it|this|the strength) \d+(?:\.\d+)? ?(?:mg|mcg|g|ml|iu|%)`],
  ['strength', String.raw`${ASK}(?:tell me|read(?: me)?|say) the strength${ON_PACK}${PLEASE}`],
  // explain_text
  [
    'explain_text',
    String.raw`what does (?:this|the|that) (?:warning|caution|precaution|direction|instruction|word|phrase|sentence|line|term|abbreviation|symbol|sign|icon|statement|note|part|section|bit|text|storage instruction) mean${SIMPLER}`,
  ],
  [
    'explain_text',
    String.raw`what do (?:these|the|those) (?:warnings|cautions|precautions|directions|instructions|words|phrases|sentences|lines|terms|abbreviations|symbols|signs|icons|statements|notes) mean${SIMPLER}`,
  ],
  ['explain_text', String.raw`what does (?:it|that|this) mean${SIMPLER}`],
  [
    'explain_text',
    String.raw`what does (?:the (?:word|term|phrase|abbreviation|sentence|line|warning|instruction|direction) )?${QUOTED} mean${SIMPLER}`,
  ],
  [
    'explain_text',
    String.raw`what does (?:the (?:word|term|phrase|abbreviation) )?${PHRASE} mean${SIMPLER}`,
  ],
  [
    'explain_text',
    String.raw`${ASK}(?:explain|simplify|clarify|rephrase|paraphrase|summari[sz]e) (?:the |this |that |these |those )?${SECTION}(?: on ${DET} ${PACK})?${SIMPLER}${PLEASE}`,
  ],
  [
    'explain_text',
    String.raw`${ASK}explain (?:it|that|this|what (?:it|that|this|${DET} ${PACK}) (?:says|means))${SIMPLER}${PLEASE}`,
  ],
  [
    'explain_text',
    String.raw`${ASK}(?:say|put|explain|word) (?:it|that|this) (?:in (?:simpler|simple|plain|easier|easy|other|everyday) (?:words|terms|language|english)|more simply|simply)${PLEASE}`,
  ],
  ['explain_text', String.raw`what (?:are|were) the ${SECTION}${ON_PACK}`],
  ['explain_text', String.raw`what (?:do|does) the ${SECTION} say`],
  [
    'explain_text',
    String.raw`how (?:should|must|can) (?:it|this|this medicine|these|the (?:tablets|capsules|medicine|bottle|pack)) be (?:stored|kept)`,
  ],
  ['explain_text', String.raw`how (?:is|are) (?:it|this|this medicine|these) (?:stored|kept)`],
  [
    'explain_text',
    String.raw`how (?:do you |to |should you )?store (?:it|this|this medicine|them)`,
  ],
  ['explain_text', String.raw`tell me (?:more )?about the ${SECTION}`],
  ['explain_text', String.raw`${ASK}read (?:me |out )?the ${SECTION}${ALOUD}(?: again)?${PLEASE}`],
  // read_label
  [
    'read_label',
    String.raw`${ASK}read (?:me |out |aloud |back )?(?:(?:${DET} )?${PACK}|it|this|that|everything|all of it|(?:the )?(?:whole|entire|full) (?:${PACK}|thing|text)|what (?:it|${DET} ${PACK}) says)${ALOUD}(?: again)?${PLEASE}`,
  ],
  ['read_label', String.raw`${ASK}read (?:me )?the ${REGION}${ALOUD}${PLEASE}`],
  ['read_label', String.raw`${ASK}(?:read|tell me|say) (?:me )?the ${FIELD}${ON_PACK}${PLEASE}`],
  [
    'read_label',
    String.raw`what does (?:${DET} )?${PACK} (?:say|read|show|state)(?: about ${TOPIC})?`,
  ],
  ['read_label', String.raw`what (?:does|do) it say(?: on ${DET} ${PACK})?(?: about ${TOPIC})?`],
  ['read_label', String.raw`what(?:'s| is) (?:printed|written|shown) (?:on|in) ${DET} ${PACK}`],
  [
    'read_label',
    String.raw`what (?:does|do) (?:the )?(?:text|words?|writing|print|wording|small print|fine print)(?: on ${DET} ${PACK})? say`,
  ],
  ['read_label', String.raw`what does the ${REGION} say`],
  ['read_label', String.raw`${ASK}tell me what (?:it|${DET} ${PACK}) says`],
  [
    'read_label',
    String.raw`what(?:'s| is| are) (?:the |its )?${FIELD}(?: (?:printed|written|shown|listed|stated))?${ON_PACK}${HERE}`,
  ],
  [
    'read_label',
    String.raw`what ${FIELD} is (?:printed|written|shown|listed|stated|on ${DET} ${PACK})(?: (?:on|in) ${DET} ${PACK})?${HERE}`,
  ],
  ['read_label', String.raw`which (?:one|part|line|word) is the ${FIELD}`],
  ['read_label', String.raw`where(?:'s| is) the ${FIELD}(?: (?:printed|written|shown))?${ON_PACK}`],
  [
    'read_label',
    String.raw`who (?:makes|made|manufactures|manufactured|produces|produced|distributes|distributed|markets|marketed) ${THING}`,
  ],
  ['read_label', String.raw`when does (?:it|this|this medicine|the medicine|${DET} pack) expire`],
  // other_label: repeat the last answer
  [
    'other_label',
    String.raw`${ASK}(?:repeat (?:that|this|it|the answer|the last (?:part|answer|sentence|bit|line))|say (?:that|it|this) again)(?: (?:more )?(?:slowly|slower|louder))?${PLEASE}`,
  ],
  ['other_label', String.raw`(?:pardon|say again|what did you say)`],
];

const ALLOW_TEMPLATES: readonly [AllowedIntent, RegExp][] = TEMPLATES.map(
  ([intent, source]) => [intent, new RegExp(String.raw`^(?:${source})$`)] as const,
);

/** Trailing characters stripped during normalisation. */
const TRAILING = new Set([' ', '?', '.', '!', ',', ';', ':']);

/**
 * Review round 1: invisible format and default-ignorable characters (soft
 * hyphen U+00AD, zero-width space and joiners U+200B-U+200D, direction marks
 * U+200E-U+200F, word joiner U+2060, BOM U+FEFF, combining grapheme joiner
 * U+034F, ...). They are removed, not replaced by a space, so one cannot split
 * a word ("s\u200Bafe") and hide it from the refusal patterns.
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
/** English only: any character outside printable ASCII left after normalisation. */
const NOT_PRINTABLE_ASCII = /[^\x20-\x7e]/;

function normalise(q: string): string {
  const text = q
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .toLowerCase()
    .replace(/[‘’‛′`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  // a linear scan, not a regex: a long run of punctuation must not backtrack
  let end = text.length;
  while (end > 0 && TRAILING.has(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

function refusalReason(text: string): RefusalReason | null {
  if (POSSIBLE_OVERDOSE.some((p) => p.test(text))) return 'possible_overdose';
  for (const [reason, patterns] of REFUSALS) {
    if (patterns.some((p) => p.test(text))) return reason;
  }
  return structuralRefusal(text) ?? modalDoseRefusal(text);
}

export function classifyQuestion(q: string): QuestionClass {
  const text = typeof q === 'string' ? normalise(q) : '';
  if (text.length === 0 || text.length > MAX_QUESTION_CHARS) {
    return { allowed: false, reason: 'outside_label' };
  }
  const reason = refusalReason(text);
  if (reason !== null) return { allowed: false, reason };
  // after the refusals, so "my baby swallowed some" followed by an emoji or an
  // em dash still gets the emergency text
  if (NOT_PRINTABLE_ASCII.test(text)) return { allowed: false, reason: 'outside_label' };
  for (const [intent, template] of ALLOW_TEMPLATES) {
    if (template.test(text)) return { allowed: true, intent };
  }
  return { allowed: false, reason: 'outside_label' };
}
