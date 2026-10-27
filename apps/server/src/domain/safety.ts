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
 * stays a dose question ("i took one, can i take another?"). Review round 4: a
 * caregiver who gave the amount counts as taking it ("i gave him too much"),
 * and so does a bigger dose ("a higher dose", "too high a dose"). Review round
 * 5: a plain size word ("a large dose"), a cup or glass of a medicine, twice
 * the dose after a food or drink verb, a second thing taken after a food
 * clause, too much reported after the fact or not counted ("i don't know how
 * many i took"), and an empty medicine container next to a child.
 */
const COUNT_WORD_2PLUS = String.raw`(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|dozens?|couple|several|many|multiple|lots|loads|heaps|tons)`;
const CONTAINER = String.raw`(?:bottles?|packs?|packets?|box(?:es)?|strips?|blisters?|jars?|tubs?|sachets?|containers?|tubes?|cartons?|vials?|syrups?|contents|supply|lot)`;
const DOSE_FORMS = String.raw`(?:pills|tablets|capsules|caplets|tabs|caps|meds|medicines|doses)`;
/** Things a count can measure that are not medicine: "it took 2 hours", "i had 2 beers". */
const NOT_MEDICINE = String.raw`(?:hours?|hrs?|minutes?|mins?|seconds?|days?|nights?|mornings?|evenings?|afternoons?|weeks?|months?|years?|yrs?|time|beers?|drinks?|glass(?:es)?|cups?|shots?|coffees?|kids?|children|people|persons?|meals?|am|pm|o'?clock|kg|kilos?|lbs?|pounds?|questions?|photos?|pictures?|care|caution|precautions?)`;
/** A word that names a medicine. Review round 4: also laxatives, antacids and other kinds ("too much chocolate laxative"). */
const MEDICINE_WORD = String.raw`\b(?:pills?|tablets?|tabs?|capsules?|caps|caplets?|syrups?|medic\w*|meds|gumm\w*|vitamins?|magnesia|chewables?|doses?|dosage|drops|drugs?|lozenges?|sachets?|supplements?|paracetamol|acetaminophen|ibuprofen|aspirin|antibiotics?|ointment|cream|laxatives?|antacids?|antihistamines?|painkillers?|sedatives?|decongestants?|suppositor\w*)\b`;
/**
 * Review round 4: after a NOT_MEDICINE word, an apostrophe or a medicine word
 * (directly or after one or two words) makes the word the owner or kind of a
 * medicine, not a time or a person: "3 children's tablets", "two kids tablets",
 * "too much night time cold medicine". A conjunction or preposition first does
 * not ("2 drinks and some pills", "2 days of tablets", "2 kids to get vitamins").
 */
const MEDICINE_NEXT = String.raw`(?:'| (?!(?:and|or|with|then|but|so|to|of|in|on|at|for|from|after|before)\b)(?:[\w']+ ){0,2}?${MEDICINE_WORD})`;
/**
 * Review round 1: too much without a count ("one too many", "a double dose",
 * "extra"); not the "extra strength" product. Review round 5: "a little extra".
 */
const TOO_MUCH = String.raw`(?:one too many\b|(?:an |some |one |1 |a (?:little(?: bit)?|bit|tad) )?extra\b(?! strength)|(?:a |the |my |his |her |their )?(?:double|triple|quadruple)\b(?![ -]check| strength))`;
/** Review round 3: an intensifier before "too much" ("way too many", "much too much", "a little too much"). */
const INTENSIFIER = String.raw`(?:wa+y+|far|much|a lot|a bit|a little(?: bit)?|a tad|slightly|really|just|so|very|definitely|probably)`;
/**
 * Review round 3: too much or so much, after up to three intensifiers, also
 * repeated or with a comma ("way, way too much", "far far too many", "so
 * many"), or after "one or two" ("one or two too many").
 */
const TOO_OR_SO = String.raw`(?:(?:${INTENSIFIER},? ){0,3}(?:too|so) (?:much|many)|(?:one|1|a|an) (?:or|to) [\w']+ too many)\b`;
/**
 * Review round 4: a count after a determiner ("the two of them", "the last 3
 * tablets", "my two pills"), but not a strength ("the 500 mg one", "the 5 ml
 * dose"). A time or a person after it ("the 2 pm dose", "my two kids") is a
 * NOT_MEDICINE word, which EXCESS excludes.
 */
const THE_COUNT = String.raw`(?:the|these|those|my|his|her|their|our) (?:(?:last|remaining|other|first|next|extra|whole) )?(?:${COUNT_WORD_2PLUS}|(?:[2-9]|[1-9]\d+)(?:\.\d+)?(?!\.?\d))\b(?! ?(?:mg|mcg|g|ml|cc|iu|%|milligrams?|grams?)\b)`;
/** Review round 5: also "quite" ("i took quite a few"). */
const EXCESS_PREFIX = String.raw`(?:(?:like|about|around|maybe|probably|at least|over|more than|almost|nearly|roughly|perhaps|quite) )?`;
/** Review round 4: one dose too many ("one pill too many"); not "one drink too many". */
const ONE_DOSE_TOO_MANY = String.raw`(?:one|1|a|an) (?:extra )?(?:dose|pill|tablet|capsule|caplet|tab|cap|spoonful|teaspoon|tablespoon|sachet) too many\b`;
/**
 * An amount that may be too much, except "too much" itself and a bare
 * container. Review round 5: "plenty of" a medicine ("plenty of pills", not
 * "plenty of water"), and part or most of a container ("a quarter of the
 * bottle", "most of the pills", "a good chunk of the bottle").
 */
const EXCESS_AMOUNT = String.raw`(?:(?:[2-9]|[1-9]\d+)(?:\.\d+)?|${COUNT_WORD_2PLUS}\b|a (?:couple|few|bunch|lot|handful|load|ton|heap|fistful|mouthful|dozen|boatload|truckload|bucketload|shedload|pile|stack)\b|plenty of (?:(?:the|my|his|her|their|these|those) )?(?:[\w'-]+ ){0,2}?${MEDICINE_WORD}|(?:(?:a |one )?(?:quarter|third|fifth)|(?:two|three) (?:quarters|thirds)|most|(?:a |one )?(?:good |big |large |huge )?(?:chunk|part|portion)) of (?:the |a |an |my |his |her |their |this |that )?(?:\w+ )?(?:${CONTAINER}|${DOSE_FORMS})\b|handfuls?\b|bunch(?:es)?\b|${TOO_MUCH}|all\b|(?:them|these|those) all\b|everything\b|(?:the |a |an |my |his |her |their |our )?(?:whole|entire|full|rest of the|remaining|leftover|left over) (?:\w+ )?(?:${CONTAINER}|${DOSE_FORMS}|things?|(?:sheets?|cards?|rows?) of)\b|${THE_COUNT}|(?:a|the) pair(?: of (?:them|these|those|em|'em|${DOSE_FORMS})\b|\b(?! of\b))|${ONE_DOSE_TOO_MANY}|the rest(?: of (?:it|them|these|those|mine))?\b(?! of\b))`;
/**
 * Not a time, a drink, a person or a photo after the amount: "it took 2 hours",
 * "i had 2 beers". Review round 4: but a person who owns the medicine is not
 * excluded ("3 children's tablets", "too many kids' tablets"). A time before a
 * dose still is ("the 2 pm dose").
 */
const OWNER_PERSON = String.raw`(?:kids?|children|people|persons?)`;
const NOT_MEDICINE_AFTER = String.raw`(?! ?(?:of )?(?:(?!${OWNER_PERSON}\b)${NOT_MEDICINE}\b|${OWNER_PERSON}\b(?!${MEDICINE_NEXT})))`;
/** An amount that may be too much: two or more, too many, a container, all of it. */
const EXCESS = String.raw`${EXCESS_PREFIX}(?:${EXCESS_AMOUNT}|${TOO_OR_SO}|(?:the |a |an |my |his |her |their |our |half (?:the|a|of the) )(?:\w+ )?${CONTAINER}\b)${NOT_MEDICINE_AFTER}`;
/**
 * Review round 4: an amount a caregiver gave that may be too much. A bare
 * container is not one ("i gave the baby the bottle"), but half of one is.
 * "Too much" has its own pattern, because food after it is not a dose.
 */
const GIVEN_EXCESS = String.raw`${EXCESS_PREFIX}(?:${EXCESS_AMOUNT}|half (?:the|a|of the) (?:\w+ )?${CONTAINER}\b)${NOT_MEDICINE_AFTER}`;
/** Past or perfect ingestion verbs, not passive ("can it be taken 2 at a time?", "is it used 3 times a day?"). */
const NOT_PASSIVE = String.raw`(?<!\b(?:be|been|being|is|are|was|were|get|gets|got|to)(?: it| this| that| they| these| those)? )`;
/**
 * Review round 4: also ingested, sipped, slurped, licked, sucked, munched,
 * drained. Review round 5: also scarfed, crunched, "tossed back", "dosed
 * myself with", "self-medicated with" and "ended up taking"; not a bare
 * "tossed" or "threw" ("i tossed 3 pills in the trash").
 */
const INGESTED = String.raw`(?:took|taken|swallowed|popped|downed|used|consumed|gobbled|chugged|gulped|guzzled|inhaled|finished|wolfed|scoffed|devoured|chewed|necked|snorted|injected|knocked|polished|ingested|sipped|slurped|licked|sucked|munched|drained|scarfed|crunched|(?:sucked|chewed|munched|nibbled) on|(?:tossed|threw|thrown) back|binged on|overindulged in|loaded up on|self[- ]medicated with|dosed (?:myself|himself|herself|themselves|ourselves|him|her|them) (?:up )?(?:with|on)|(?:ended|wound) up (?:taking|swallowing|using|popping|downing|chugging))`;
/**
 * Food and drink verbs: "too much", "one too many", "extra" or "a double" after
 * these is usually food or alcohol, so only counts and containers count.
 */
const INGESTED_FOOD = String.raw`(?:ate|eaten|drank|drunk|had|(?:ended|wound) up (?:having|drinking|eating))`;
const PARTICLE = String.raw`(?: (?:down|back|off|through|up))?`;
/**
 * Review round 4: a caregiver gave a dose ("i gave him", "she was given", "the
 * nurse administered"), but not a question about how it is given ("can it be
 * given 2 at a time?", "is it given twice a day?"). Review round 5: "ended up
 * giving".
 */
const GAVE = String.raw`(?:\b(?:gave|administered)|(?<!\b(?:be|is|are|being|to|gets?)(?: it| this| that| they| these| those)? )\bgiven|\b(?:ended|wound) up giving)`;
/**
 * Review round 4: who was given it, if named: a pronoun, a determiner and up to
 * four words ("my 2 year old"), or one other word such as a name. Not "me" or
 * "us" ("the doctor gave me two tablets" is a supply, not a dose), and not a
 * word that makes "gave" mean something else ("gave birth", "gave up").
 * RECIPIENT_WORD is never a determiner or an amount word, so the recipient
 * cannot swallow the thing given ("the baby the bottle", "him too much").
 */
const RECIPIENT_WORD = String.raw`(?!(?:the|a|an|my|his|her|their|our|your|this|that|these|those|some|it|its|them|too|so|more|another|both|all|half|one|extra|double|twice)\b)[\w']+`;
/** Review round 5: a named recipient, required ("i gave him a large amount", but not "i gave a large amount to charity"). */
const RECIPIENT_REQ = String.raw` (?:him|her|them|myself|himself|herself|themselves|(?:my|his|her|their|our|your|the|a|an) (?:${RECIPIENT_WORD} ){0,3}?${RECIPIENT_WORD}|(?!(?:me|us|up|away|back|out|in|off|birth|blood|way|rise|notice|permission|consent|instructions?|directions?|advice)\b)${RECIPIENT_WORD})`;
const RECIPIENT = String.raw`(?:${RECIPIENT_REQ})?`;
/** Review round 4: someone took it, or a caregiver gave it to someone. */
const TOOK_VERB = String.raw`(?:${NOT_PASSIVE}\b${INGESTED}${PARTICLE}|${GAVE}${RECIPIENT})`;
/** Review round 1: an age that stands for a person ("my 2 year old", "her 18-month-old", "my 3yo"). */
const AGE = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen)[ -]?(?:(?:years?|yrs?|months?|mos?|weeks?|wks?)[ -]?old|y\.?o\.?)`;
/** Review round 5: also step- and god-children, boys and girls, and a little brother or sister. */
const CHILD = String.raw`(?:kids?|child|children|baby|babies|toddlers?|infants?|newborns?|little ones?|sons?|daughters?|grand(?:son|daughter|child|kid)s?|(?:step|god)(?:sons?|daughters?|kids?|child(?:ren)?)|boys?|girls?|(?:little|baby|younger) (?:brothers?|sisters?)|kiddos?|tots?|nephews?|nieces?|anak|bata|sanggol|${AGE})`;
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
/** Review round 4: a medicine a child took or put in the mouth. */
const CHILD_DOSE_NOUN = String.raw`(?:pills?|tablets?|capsules?|caplets?|tabs?|caps|medicines?|medications?|meds|syrups?|drops|doses?|vitamins?|gummies|amounts?|quantit(?:y|ies))`;
/**
 * Review round 5: a plain size word before an amount ("a large dose", "a big
 * handful", "a large number of pills"), and the comparatives ("a larger amount
 * of syrup"). SIZE_AMOUNT takes it only after "a" or "an", or before a plural
 * noun, so a product ("the high dose one") or a condition ("my high blood
 * pressure pill") is not an amount.
 */
const SIZE_WORD = String.raw`(?:large|big|high|huge|massive|excessive|enormous|giant|gigantic|hefty|heavy|whopping|great|substantial|significant|considerable|sizeable|sizable|generous|crazy|insane|ridiculous|stupid|silly|absurd|obscene|ungodly|monster|mega|astronomical|tremendous|colossal|immense|dangerous|unsafe|extreme|unknown|larger|bigger|higher|greater|heavier)`;
const SIZE_INTENS = String.raw`(?:(?:very|really|super|quite|pretty|rather|fairly|extremely|dangerously|seriously|insanely|ridiculously|way|much|far|even|overly|excessively|unusually|abnormally|incredibly) )?`;
/** A dose word between the size word and the noun: "a large single dose", "a big adult dose". */
const SIZE_DOSE_MOD = String.raw`(?:(?:single|daily|extra|first|second|whole|full|adult|night|nightly|morning|evening|initial|total) )?`;
const SIZE_NOUN = String.raw`(?:amount|number|quantity|dose|dosage|handful|fistful|spoonful|mouthful|gulp|swig|helping|portion|serving|volume)`;
const SIZE_NOUNS = String.raw`(?:amounts|numbers|quantities|doses|dosages|handfuls|fistfuls|spoonfuls|mouthfuls|gulps|swigs|helpings|portions|servings|volumes)`;
const SIZE_AMOUNT = String.raw`(?:(?:such )?an? ${SIZE_INTENS}${SIZE_WORD} ${SIZE_DOSE_MOD}${SIZE_NOUN}|${SIZE_INTENS}${SIZE_WORD} ${SIZE_DOSE_MOD}${SIZE_NOUNS}|a (?:great|good) deal|an? mega-?dose|mega-?doses)\b`;
/** A size word before a dose needs nothing after it ("i had a big dose"). */
const SIZE_DOSE = String.raw`(?:(?:such )?an? ${SIZE_INTENS}${SIZE_WORD} ${SIZE_DOSE_MOD}(?:dose|dosage)|${SIZE_INTENS}${SIZE_WORD} ${SIZE_DOSE_MOD}(?:doses|dosages))\b`;
/**
 * Review round 5: a cup, a glass or another drinking vessel ("a cup of cough
 * syrup", "half a glass of the medicine", "two mugs of it"). For an adult, a
 * capful, a shot, a swig or a sip is not on this list: a capful or a shot is
 * the label's own dose measure ("take one capful"). For a child it counts.
 */
const VESSEL = String.raw`(?:cups?|cupfuls?|glass(?:es)?|glassfuls?|mugs?|mugfuls?|bottlefuls?|jugs?|pints?|tumblers?|beakers?)`;
const VESSEL_QUANT = String.raw`(?:(?:an?|one|1|half(?: an?| of an?)?|a half|one half|a whole|a full|the whole|the full|an entire|the entire|a couple(?: of)?|a few|several|${COUNT_WORD_2PLUS}|\d+(?:\.\d+)?) )?(?:${SIZE_INTENS}(?:${SIZE_WORD}|tall|full|whole|entire) )?`;
/** Review round 5: two or more of a measure that one dose may be ("2 shots of nyquil", "two capfuls of the syrup"). */
const COUNTED_MEASURE = String.raw`(?:${COUNT_WORD_2PLUS}|(?:[2-9]|[1-9]\d+)(?:\.\d+)?|a (?:few|couple)(?: of)?|several) (?:shots?|shot glass(?:es)?|capfuls?|swigs?|gulps?|sips?|spoonfuls?|mouthfuls?)`;
/** Review round 5: a child's measure of something, also a bowl or a shot glass; NOT_CHILD_FOOD decides whether it is food. */
const CHILD_MEASURE = String.raw`${VESSEL_QUANT}(?:${VESSEL}(?: full)?|shot glass(?:es)?|bowls?|bowlfuls?|gulps?|swigs?|sips?|capfuls?|shots?|mouthfuls?|spoonfuls?|droppers?(?:fuls?)?) of`;
/**
 * Review round 4: whose medicine it was ("grandma's", "his sister's", "the
 * neighbor's"). Review round 5: also hyphenated, two words, "in law" or plural
 * ("my mother-in-law's", "my best friend's", "my mother in law's", "my
 * grandparents'").
 */
const OWNER = String.raw`(?:(?:a|an|the|my|his|her|their|our|your) )?(?:[a-z][\w-]* )?[a-z][\w-]*(?: in[- ]law)?(?:'s|s')`;
/**
 * What a child took. Review round 4: also an owner's medicine ("grandma's
 * pill", "his sister's tablet"), up to two words before the medicine with or
 * without a determiner ("my blood pressure pill", "heart pills"), and too much
 * ("drank too much", "ate way too much"); food after it is excluded by
 * NOT_CHILD_FOOD. A negation is not an object ("had no medicine today").
 * Review round 5: a measure ("a cup of", "a big gulp of", "half a cup of"),
 * hyphenated words ("my step-mom's pill"), and "out of" or "from" before the
 * medicine ("drank out of the syrup bottle"; "from my water bottle" is not).
 */
const CHILD_OBJECT = String.raw`(?:some|one|it|them|all|any|a few|a bunch|a lot|a handful|a couple|several|many|\d+|${COUNT_WORD_2PLUS}|(?:${INTENSIFIER},? ){0,3}(?:too|so) (?:much|many)|${CHILD_MEASURE}|(?:a|an|the|my|his|her|their|our|your)(?: [\w'-]+){0,2} (?:${CHILD_DOSE_NOUN}|${CONTAINER}|spoonfuls?|sips?|bites?|bits?|pieces?)|${OWNER}(?: [\w'-]+){0,2} (?:${CHILD_DOSE_NOUN}|${CONTAINER})|(?!(?:no|not|never|none|zero)\b)(?:(?:out of|from|off) )?(?:[\w'-]+ ){0,2}${CHILD_DOSE_NOUN})`;
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
/** Review round 3: a child reaching medicine; after a food word it keeps the emergency text. */
/** Review round 4: also "got his hands on". */
const CHILD_ACCESS = String.raw`(?:got into|gotten into|got in to|got (?:a )?hold of|got ahold of|got at|got (?:his |her |their |its )?hands? on|grabbed|found|opened|reached)`;
/**
 * Review round 4: the only words that may stand before a child's food or drink
 * ("orange juice", "warm milk", "chicken soup"). The list is closed: any other
 * word before the food word ("bleach water", "Fevrex juice", "laced juice",
 * "cough juice") is not food, so the emergency text stays. "herbal" is left
 * out on purpose: a herbal tea can be a medicine.
 */
const FOOD_MOD = String.raw`(?:orange|apple|grape|pineapple|mango|lemon|lime|coconut|chocolate|strawberry|banana|fruit|sugar|warm|cold|hot|iced|plain|fresh|breast|cow's|soy|almond|oat|whole|skim|baby|chicken|vegetable|green|black|tap|bottled|boiled|filtered|mineral|sparkling)`;
const NOT_CHILD_FOOD = String.raw`(?! (?:of )?(?:the |his |her |their |my |your |a |an |some )?(?:${FOOD_MOD} )?${CHILD_FOOD}${FOOD_END}(?!.*(?:${MEDICINE_WORD}|\b(?:${CHILD_INGESTED}|${CHILD_ACCESS})\b)))`;
/**
 * Review round 4: food and drink that "too much" may be about after a food or
 * drink verb. Review round 5: more drinks and foods ("a glass of lemonade").
 */
const ADULT_FOOD = String.raw`(?:${CHILD_FOOD}|coffee|caffeine|soda|softdrinks?|coke|cola|wine|beer|alcohol|liquor|booze|vodka|whisky|whiskey|rum|gin|tequila|cider|champagne|lager|ale|cocktails?|punch|lemonade|smoothies?|milkshakes?|cocoa|latte|cappuccino|espresso|broth|yogh?urt|porridge|oatmeal|ice cream|ice|pizza|cake|candy|chocolate|sweets|sugar|salt|dessert|chips|cookies|biscuits|crackers|popcorn|nuts|fries|burgers?|sandwich(?:es)?|chicken|fish|eggs|salad|meat|pasta|noodles|cheese|junk food|fast food)`;
/**
 * Review round 4: words after "too much" that start a clause or name a time, a
 * person or a feeling, not a thing taken. A time or person word followed by an
 * apostrophe or a medicine word is the owner or kind of a medicine, so it is a
 * thing taken ("too much of the kids' syrup", "too much night time medicine").
 * Review round 5: also money and effort ("a large amount of money").
 */
const NOT_A_THING = String.raw`(?:(?:of|the|a|an|my|his|her|their|our|your|this|that|these|those|some|and|but|so|then|or|because|cause|since|when|while|after|before|until|till|at|in|on|for|during|over|with|without|to|today|tonight|yesterday|earlier|recently|lately|again|already|now|last|lol|haha|i|he|she|we|they|you|it)\b|(?:${NOT_MEDICINE}|fun|work|homework|housework|paperwork|schoolwork|stress|pain|trouble|sleep|energy|screen|money|cash|dollars?|pesos?|bucks|effort|attention|thought|patience|love|sun|sunlight|exercise)\b(?!${MEDICINE_NEXT}))`;
/**
 * Review round 5: what may follow a food or drink word that ends its phrase:
 * punctuation, the end, a conjunction, a preposition, a time, a pronoun, a
 * determiner or a modal ("too much coffee, can i...", "too much wine last
 * night", "too much salt in my food"). Any other word after the food word
 * makes the food word a modifier, so the phrase is not food and fails closed:
 * "too much sugar free cough syrup", "too much chocolate ex-lax", "too much
 * sugar-free fevrex".
 */
const FOOD_TAIL = String.raw`(?:and|or|but|then|so|because|cause|since|when|while|after|before|until|till|at|in|on|for|from|during|over|without|to|as|like|today|tonight|yesterday|earlier|recently|lately|again|already|now|last|this|that|these|those|lol|haha|tbh|rn|probably|maybe|honestly|though|tho|anyway|also|too|instead|every|each|per|daily|i|i'm|im|i've|ive|i'd|he|she|we|they|you|it|its|it's|me|my|his|her|their|our|your|the|a|an|can|could|should|would|will|is|was|did|do|does|am|are|were|has|have|had|may|might|must|which|who|please)`;
/** Words that may stand before a food word inside its phrase ("warm milk", "sugar free soda", "coffee cake"). */
const FOOD_PHRASE_MOD = String.raw`(?:${FOOD_MOD}|milk|rice|coffee|ice|beer|wine|cheese|cream|peanut|cookie|candy|egg|potato|corn|tomato|beef|pork|fish|cake|sugar[- ]free|sugarless|diet|decaf|low[- ]fat|fat[- ]free|non[- ]?fat|skimmed)`;
/** Up to two modifiers, then a food word that ends the phrase. */
const foodPhrase = (tail: string): string =>
  String.raw`(?:${FOOD_PHRASE_MOD} ){0,2}${ADULT_FOOD}(?=[,.?!;:)]|-(?!\w)|$| ${tail}\b)`;
/** After "too much": "with" does not end the phrase ("too much tea with my pills" is not plain tea). */
const FOOD_PHRASE = foodPhrase(FOOD_TAIL);
/** After an amount "of": "with" ends the phrase ("a glass of water with my tablet" is plain water). */
const FOOD_PHRASE_WITH = foodPhrase(String.raw`(?:${FOOD_TAIL}|with)`);
/**
 * Review round 4: the thing after "too much" or "so much" following a food or
 * drink verb ("too much syrup", "too much of the medicine", "too much of it").
 * It fails closed: anything other than food, drink, a time or the start of a
 * clause counts as a medicine, so a brand name keeps the emergency text ("too
 * much fevrex"). Review round 5: a food word is food only when it ends its
 * phrase (FOOD_PHRASE), so "too much milk of magnesia", "too much sugar free
 * cough syrup" and "too much chocolate ex-lax" are not food.
 */
const TOO_MUCH_THING = String.raw`(?:of (?:it|them)\b|of (?:this|that|these|those)\b(?! [a-z])|(?:of )?(?:(?:the|my|his|her|their|our|your|this|that|these|those|some) )?(?!${NOT_A_THING}|${FOOD_PHRASE})[a-z][\w'-]*)`;
/**
 * Review round 5: what an amount is "of" ("a large amount of cough syrup", "a
 * cup of the medicine", "of it"). Plain food or drink that ends its phrase, a
 * time, a person or a photo is not a medicine; anything else fails closed, so
 * a brand name keeps the emergency text ("a cup of fevrex").
 */
const OF_THING = String.raw`of (?:(?:it|them)\b|(?:this|that|these|those)\b(?! [a-z])|(?:(?:the|my|his|her|their|our|your|this|that|these|those|some) )?(?!${NOT_A_THING}|${FOOD_PHRASE_WITH})[a-z][\w'-]*)`;
/**
 * Review round 3: what a child put in the mouth, also "one of my pills", "some
 * of grandma's tablets", "one of those", "a couple of them", "something",
 * and a count before the noun ("some pills", "two tablets").
 */
const MOUTH_OBJECT = String.raw`(?:${CHILD_OBJECT}|something|(?:some|any|a few|a couple(?: of)?|several|many|${COUNT_WORD_2PLUS}|\d+) (?:[\w'-]+ )?(?:pills?|tablets?|capsules?|caplets?|tabs?|caps|medicines?|meds|vitamins?|gummies)|(?:the )?(?:one|some|any|a few|a couple|several|half|${COUNT_WORD_2PLUS}|\d+) of (?:them|these|those|it|mine|his|hers|theirs|ours|yours|(?:(?:the|my|his|her|their|your|our|these|those) )?(?:[\w'-]+ ){0,2}?(?:pills?|tablets?|capsules?|caplets?|tabs?|caps|medicines?|medications?|meds|vitamins?|gummies)))`;
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
/** Review round 4: "higher than the recommended dose", "larger than recommended". */
const MORE_WORD = String.raw`(?:more|higher|greater|bigger|larger|stronger)`;
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
/**
 * Review round 4: a limit counted in doses ("the recommended number of
 * tablets", "the recommended number"), but not a number of anything else ("the
 * number of characters"). Review round 5: also measures ("the recommended
 * number of ml", "of tablespoons", "of puffs").
 */
const NUMBER_OF = String.raw`number(?: of (?:(?:daily|individual|single|separate) )?(?:${PILL}|caps|doses|meds|medicines|medications|spoonfuls|teaspoons|tablespoons|tbsps?|tsps?|ml|mls|millilit(?:er|re)s|mg|milligrams|grams|gummies|lozenges|puffs|sprays|squirts|drops|sachets|chewables|vitamins|times))?(?! of\b)`;
/**
 * Review round 3: a limit word before the noun ("the recommended dose", "the
 * daily limit"). Review round 5: also suggested, upper, labeled, right,
 * correct and "24 hour" ("the upper limit", "the suggested dose").
 */
const LIMIT_ADJ = String.raw`(?:recommended|daily|maximum|max|stated|prescribed|usual|normal|safe|printed|single|allowed|permitted|suggested|upper|label|labell?ed|correct|right|proper|standard|regular|indicated|directed|advised|specified|approved|acceptable|permissible|total|adult|(?:24|twenty[- ]four)[- ]hours?)`;
/** Review round 5: a serving, but not a serving of something ("the recommended servings of vegetables"). */
const SERVING = String.raw`servings?\b(?! of\b)`;
/**
 * Review round 5: the limit nouns share LIMIT_ADJ, and "quantity", "limit",
 * "volume" and a serving join them ("more than the allowed quantity").
 */
const THAN_LABEL = String.raw`(?:(?:it|(?:the|its|my|his|her|their|our) (?:doctor|doc|pharmacist|physician|nurse)) ${LABEL_VERB}|(?:the|its|my|his|her|their|our) (?:label|pack|box|bottle|leaflet|insert|directions?|instructions?|prescription)(?: ${LABEL_VERB})?|(?:printed |written |stated )?(?:on|in) (?:the|its|my|his|her|their) (?:label|pack|box|bottle|leaflet|insert|directions|instructions|prescription)|recommended|directed|prescribed|allowed|advised|instructed|indicated|stated|printed|written|(?:the |its |my |his |her |their |our |a )?(?:${LIMIT_ADJ} ){0,2}(?:dose|doses|dosage|amount|quantit(?:y|ies)|volume|${SERVING}|allowance|intake|limit|maximum|max|${NUMBER_OF}))\b`;
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
 * this is usually food, so not there. Review round 5: "the both", "both of
 * em", and a time after a bare "both" ("i took both last night").
 */
const BOTH_THEM = String.raw`(?:(?:the )?both(?: of)? (?:them|these|those|em|'em)\b|(?:them|these|those|em|'em) both\b|(?:the )?both\b(?=${CLAUSE_END}| (?:at once|at the same time|together|in one go|one after the other|last night|yesterday|earlier|tonight|this (?:morning|afternoon|evening))\b))`;
/**
 * Review round 3: over a limit ("i exceeded the dose", "i took over the
 * limit", "she went over the maximum"), but not "the maximum temperature" or
 * "went over the dosage instructions". LIMIT_MOD is an amount before the limit
 * ("the 4g limit", "the 4000 mg daily limit", "the 8 tablet limit"); review
 * round 5: also a time ("the 24 hour limit", "the 3 day limit").
 */
const LIMIT_MOD = String.raw`(?:${LIMIT_ADJ}|\d+[ -]?(?:hours?|hrs?|h|days?)\b|\d+(?:\.\d+)? ?(?:mg|mcg|g|grams?|ml)?|mg|mcg|g|grams?|ml|${PILL}|doses?|dosage)`;
/** Review round 4: also "allowance", "intake" and "the recommended number of tablets". Review round 5: "quantity", "volume". */
const LIMIT_NOUN = String.raw`(?:dose|doses|dosage|amount|quantit(?:y|ies)|volume|${SERVING}|limit|max(?:imum)?|allowance|intake|threshold|${NUMBER_OF})\b(?! (?:temperature|temp|storage|heat|humidity|shelf|instructions?|directions?|info\w*|sections?|chart|table|guide|label|details?|with|again)\b)`;
/** Review round 3: "way over", "well above", "a bit over". */
const OVER_ADV = String.raw`(?:(?:way|well|far|much|a bit|a little|slightly|just|probably|definitely|already|now|really) )*`;
const OVER = String.raw`${OVER_ADV}(?:over|above|beyond|past)`;
/** Review round 3: being over a limit ("i'm over the daily limit", "she is way over the max"). */
const BE_PERSON = String.raw`(?:i'm|im|i am|i've been|ive been|i was|he's|hes|he is|he was|she's|shes|she is|she was|we're|we are|we were|they're|theyre|they are|they were)`;
/** Review round 4: also a caregiver ("i gave him over the recommended dose"). */
const OVER_LIMIT = String.raw`(?:exceeded|surpassed|overshot|passed|(?:took|taken|went|gone|used|${GAVE}${RECIPIENT}) ${OVER}|${BE_PERSON} ${OVER}|did (?:i|we|he|she|they|someone|(?:my|his|her|their|the) \w+) (?:exceed|overshoot|pass|go ${OVER}))(?: (?:the|my|his|her|their|its|our|a))?(?: ${LIMIT_MOD}){0,3} ${LIMIT_NOUN}`;
/** Review round 2: one more dose ("another one", "a second dose"); after a food verb the noun is required. */
const ANOTHER = String.raw`(?:another|a second|a 2nd|an additional|one more|1 more|an extra)`;
const EXTRA_DOSE_NOUN = String.raw`(?:one|dose|${PILL}|spoonful|teaspoon|sachet)`;
/**
 * Not "another photo" or "another picture": NOT_MEDICINE after the bare form.
 * Review round 4: also a caregiver ("i gave him another dose by mistake",
 * "she was given a second dose by mistake").
 */
const TOOK_ANOTHER = String.raw`(?:${NOT_PASSIVE}\b${INGESTED}${PARTICLE} ${ANOTHER}(?: ${EXTRA_DOSE_NOUN})?|${NOT_PASSIVE}\b${INGESTED_FOOD} ${ANOTHER} ${EXTRA_DOSE_NOUN}|${GAVE}${RECIPIENT} ${ANOTHER}(?: ${EXTRA_DOSE_NOUN})?)\b(?! ${NOT_MEDICINE}\b)`;
/** Review round 5: also the misspellings "accidently" and "accidentaly". */
const BY_MISTAKE = String.raw`(?:by (?:mistake|accident)|accident(?:al+y|ly)|mistakenly|in error|unintentionally|without thinking)`;
/** Review round 4: "gave it to him twice", "gave the syrup to my son again". */
const TO_SOMEONE = String.raw`(?: to (?:him|her|them|(?:my|his|her|their|our|the) [\w']+(?: [\w']+)?))?`;
/**
 * Review round 4: a bigger dose than usual ("a higher dose", "a much bigger
 * dose", "larger doses", "a higher than normal dose", "too high a dose", "a too
 * high dose", "a dose that was too high", "a dose higher than recommended").
 */
const BIGGER = String.raw`(?:higher|bigger|larger|stronger|greater|heavier|excessive|huge|massive|enormous|(?:overly|excessively|very|really|super|dangerously|extremely|unusually|abnormally) (?:high|big|large|strong|heavy))`;
const TOO_BIG = String.raw`too (?:high|big|large|strong|great|heavy)`;
/** NOUN is the dose word: any amount after an ingestion or giving verb, only a dose after a food or drink verb. */
const biggerDose = (noun: string): string =>
  String.raw`(?:(?:(?:a|an|the|my|his|her|their|our) )?(?:(?:much|way|far|a lot|a bit|a little|slightly|even|significantly|considerably|really|very) )?${BIGGER}(?:[ -][\w']+){0,2}|(?:(?:way|far|much|a bit|a little|slightly|really) )?${TOO_BIG}(?: of)? an?|an? ${TOO_BIG}) ${noun}\b|(?:a|an|the|my|his|her|their|our) ${noun} (?:(?:that|which) (?:was|were|is|are|(?:may|might) (?:be|have been)) )?(?:(?:way|far|much|a bit|a little|slightly) )?(?:${TOO_BIG}\b|(?:higher|bigger|larger|greater|stronger) than\b)`;
const BIGGER_DOSE = biggerDose(
  String.raw`(?:doses?|dosages?|amounts?|quantit(?:y|ies)|spoonfuls?|teaspoons?|tablespoons?)`,
);
/** After a food or drink verb only a dose: "i had a bigger amount of rice" is food. */
const BIGGER_DOSE_FOOD = biggerDose(String.raw`(?:doses?|dosages?)`);
/**
 * Review round 4: too much over time, or asked about while taking it ("i've been
 * taking too many", "i keep taking more than the label says", "am i taking too
 * much?", "i'm giving him too much"); a schedule ("i'm taking two a day") is not.
 */
const ONGOING = String.raw`(?:been|keep|keeps|kept|${BE_PERSON}|am i|are (?:we|they|you)|is (?:he|she|(?:my|his|her|their|the) [\w']+))`;
const TAKING = String.raw`(?:taking|using|swallowing|popping|giving${RECIPIENT})`;
/**
 * Review round 5: a large amount, or a cup or glass, of a thing that is not
 * food ("a large amount of cough syrup", "a big handful of pills", "a cup of
 * the syrup"); "a large number of photos" and "a glass of water" are not.
 */
const AMOUNT_OF = String.raw`(?:${SIZE_AMOUNT}|${VESSEL_QUANT}${VESSEL}(?: full)?|${COUNTED_MEASURE}) ${OF_THING}`;
/** After an ingestion verb a large amount may also stand alone ("i took a large amount"). */
const SIZE_EXCESS = String.raw`(?:${AMOUNT_OF}|${SIZE_AMOUNT}(?! of\b)${NOT_MEDICINE_AFTER})`;
/**
 * Review round 5: after a food, drink or giving verb, a large amount must be of
 * a thing that is not food, or more than the label, or a dose ("i drank a large
 * amount of cough syrup", "i had a larger amount than recommended", "i had a big
 * dose"); "i ate a large amount of rice" is food.
 */
const SIZE_EXCESS_FOOD = String.raw`(?:${AMOUNT_OF}|${SIZE_AMOUNT} than ${THAN_WHAT}${THAN_LABEL}|${SIZE_DOSE}(?! of\b))`;
/** Review round 5: a multiple of an amount ("twice the dose", "double what the label says", "3x the dose"). */
const MULTIPLE = String.raw`(?:twice|double|triple|thrice|quadruple|(?:two|three|four|five|ten|[2-9]|10) times|[2-9] ?x)`;
const MULTIPLE_AS = String.raw`(?:as (?:much|many)(?: [\w'-]+){0,2}? as )?`;
/**
 * A multiple of a named dose, or of what the person usually takes ("twice as
 * many pills as i should", "double what i usually take"); these hold after a
 * food or drink verb too.
 */
const MULTIPLE_DOSE = String.raw`${MULTIPLE} (?:as (?:much|many)${MORE_DOSE} as (?:${THAN_WHAT}${THAN_LABEL}|${THAN_USUAL}|${THAN_WHAT}${THAN_PERSON})|what (?:i|he|she|we|they|you)(?:'m|'re|'s)? (?:(?:usually|normally|always|would) )?(?:take|takes|use|uses|should(?: have)? (?:take|taken|use|have)|(?:was|am|is|are|were) (?:supposed|told|meant) to (?:take|have|use)|need|needed|was prescribed|am prescribed)\b)`;
/**
 * What a multiple is of after a food or drink verb: the dose or the label
 * ("twice the recommended dose", "twice as much as the label says", "double the
 * amount"), but not food ("double the amount of rice").
 */
const MULTIPLE_OF = String.raw`(?:${MULTIPLE} ${MULTIPLE_AS}${THAN_WHAT}${THAN_LABEL}(?: ${OF_THING}|(?! of\b))|${MULTIPLE_DOSE})`;
/** A plain or usual amount ("the amount", "the usual amount"). */
const PLAIN_AMOUNT = String.raw`(?:the |my |his |her |their |our )?(?:(?:usual|normal|regular) )?(?:amount|quantity|number)\b`;
/** The label or a prescriber after an amount ("on the label", "the label says", "recommended"). */
const LABEL_TAIL = String.raw` (?:(?:printed |written |stated )?(?:on|in) (?:the|its|my|his|her|their) (?:label|pack|box|bottle|leaflet|insert|directions|instructions|prescription)|(?:that )?(?:the|its|my|his|her|their) (?:label|pack|box|bottle|leaflet|directions|instructions|prescription|doctor|doc|pharmacist) ${LABEL_VERB}|${LABEL_VERB})\b`;
/**
 * After "ate", a plain or usual amount is food unless the label is named ("i
 * ate twice the amount" is food; "twice the amount on the label" is not).
 */
const MULTIPLE_OF_ATE = String.raw`(?:${MULTIPLE} ${MULTIPLE_AS}${THAN_WHAT}(?:${PLAIN_AMOUNT}${LABEL_TAIL}|(?!${PLAIN_AMOUNT})${THAN_LABEL}(?: ${OF_THING}|(?! of\b)))|${MULTIPLE_DOSE})`;
/** Review round 5: "and", "plus" or "as well as" before a second thing taken. */
const AND_ALSO = String.raw`,? (?:and|plus|as well as|along with|together with|&)(?: then| also)?`;
/** A word inside a second object, never a pronoun, a determiner or a verb ("and took my pills" is a clause). */
const OBJECT_WORD = String.raw`(?!(?:i|he|she|we|they|you|it|me|him|them|us|my|his|her|their|our|your|the|a|an|this|that|these|those|took|take|takes|taking|taken|had|have|has|having|was|were|is|are|am|be|been|can|could|should|would|will|may|might|must|did|do|does|need|needs|needed|forgot|forget|forgets|missed|skipped|got|get|gets|felt|feel|feels|went|made|make|makes|then|now|so|but)\b)[\w'-]+`;
/**
 * A second thing that is too much on its own: too much of a thing, an extra or
 * double dose, two or more, a lot, all of it, a large amount. Two or more of
 * a thing that is not food and ends the clause counts as a medicine too, so a
 * brand name keeps the emergency text ("and 2 xanax"; "and two friends came
 * over" is not one).
 */
const SECOND_EXCESS = String.raw`(?:${TOO_OR_SO} ${TOO_MUCH_THING}|${TOO_MUCH} (?:${OBJECT_WORD} )?(?:doses?|${PILL}|spoonfuls?|teaspoons?|tablespoons?)\b|(?:${COUNT_WORD_2PLUS}|(?:[2-9]|[1-9]\d+)(?:\.\d+)?|a (?:few|couple|lot|bunch|handful|load|ton|heap|fistful))(?: of)? (?:(?:the|my|his|her|their|our|these|those) )?(?!${NOT_A_THING}|${FOOD_PHRASE_WITH})[a-z][\w'-]*(?=[,.?!;]|$| (?:and|but|so|then|last|today|tonight|yesterday|earlier|too|now|at once|together|i|he|she|we|they)\b)|(?:${COUNT_WORD_2PLUS}|(?:[2-9]|[1-9]\d+)(?:\.\d+)?|a (?:few|couple|lot|bunch|handful|load|ton|heap|fistful)|all|the whole|the rest|${SIZE_AMOUNT})(?: of)? (?:(?:the|my|his|her|their|our|these|those) )?(?:${OBJECT_WORD} ){0,2}?${MEDICINE_WORD})`;
/** After a too-much clause, "some" or a bare medicine counts too ("too much tea and medicine"). */
const SECOND_MEDICINE = String.raw`(?:(?:some|a few|more|extra|several)(?: of)? (?:(?:the|my|his|her|their|our|these|those) )?)?(?:${OBJECT_WORD} ){0,2}?${MEDICINE_WORD}`;
/** Review round 5: not knowing how much was taken ("i don't know how many", "i lost count of how many"). */
const UNSURE = String.raw`(?:(?:(?:do|did|does)(?:n'?t| not)|can'?t|cannot|can not|couldn'?t|could not) (?:know|remember|recall|tell|say|count|be sure)|(?:not|un) ?sure|not certain|uncertain|no (?:idea|clue)|lost (?:count|track)|forgot|who knows)`;
/**
 * Review round 5: an empty medicine container ("an empty pill bottle", "an
 * empty bottle of children's tylenol", "an empty blister pack"), but not an
 * empty water bottle or a bare empty box.
 */
const EMPTY_CONTAINER = String.raw`(?:half[- ])?empty (?:(?:${OBJECT_WORD} ){0,2}?(?:blisters?(?: packs?)?|pill ?box(?:es)?|pill ?cases?|strips?|sachets?|vials?)\b|(?:[\w'-]+ ){0,2}?(?:bottles?|packs?|packets?|box(?:es)?|containers?|jars?|tubs?|tubes?) of(?! (?:(?:the|my|his|her|some) )?(?:${FOOD_MOD} )?${ADULT_FOOD}\b)|(?:[\w'-]+ )?${MEDICINE_WORD} (?:bottles?|packs?|packets?|box(?:es)?|containers?|jars?|tubs?|tubes?)\b)`;
/** Review round 5: an ingestion reported after the fact ("after taking", "since swallowing", "after giving him"). */
const AFTER_TAKING = String.raw`\b(?:after|since|from|following) (?:(?:accidentally|accidently|mistakenly) )?(?:taking|swallowing|using|popping|chewing|downing|ingesting|consuming|giving${RECIPIENT})`;
/** Review round 4: asking whether too much was taken ("did i take", "did she swallow", "did i give him"). */
const DID_TAKE = String.raw`\bdid (?:i|we|he|she|they|someone|somebody|(?:my|his|her|their|the) \w+) (?:take|swallow|use|eat|drink|have|give${RECIPIENT})`;
/**
 * Review round 5: an amount that is too much after taking it over time, after
 * the fact or asked about ("i've been taking too many", "after taking double
 * the dose", "did i take a big dose?"). The three share this one tail, so the
 * large building blocks are compiled once.
 */
const EXCESS_TAIL = String.raw`(?:(?:${TOO_OR_SO}|${TOO_MUCH})${NOT_MEDICINE_AFTER}|(?:(?:way|much|far|a bit|a lot|slightly) )?${MORE_WORD}${MORE_NOUN} than (?:${THAN_WHAT}${THAN_LABEL}|(?:usual|normal|normally|usually)\b|${THAN_WHAT}${THAN_PERSON}|${THAN_MULTIPLE})|${BIGGER_DOSE}|${MULTIPLE_OF}|${SIZE_EXCESS}|${REPEATED}|(?:the |a |an |my |his |her |their )?(?:whole|entire|full|rest of the) (?:\w+ )?(?:${CONTAINER}|${DOSE_FORMS})\b|(?:all|most) of (?:it|them|the \w+|my \w+))`;
/** Review round 5: a storage subject before a limit verb ("the temperature exceeded what the label says"). */
const NOT_STORAGE = String.raw`(?<!\b(?:temperature|temperatures|temp|heat|humidity|storage|room|car|weather|fridge|freezer|box|pack|bottle|label|it|that|this|which) )`;

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
  // review round 4: "too much" or "so much" and a thing that is not food after
  // a food or drink verb ("i drank too much of this syrup", "i had too much
  // paracetamol", "i had too much of it"), also over time ("i've been drinking
  // too much cough syrup") or measured out ("i put too much medicine in his
  // bottle")
  new RegExp(
    String.raw`(?:${NOT_PASSIVE}\b${INGESTED_FOOD}${PARTICLE}|\bfed${RECIPIENT}|\b(?:been|keep|keeps|kept|${BE_PERSON}) (?:drinking|having|eating)|\b(?:put|poured|measured|squirted|added|mixed)(?: (?:in|out|up))?) (?:(?:${INTENSIFIER}|(?:too|so) much),? ){0,3}(?:too|so) much ${TOO_MUCH_THING}`,
  ),
  // review round 4: a caregiver gave too much ("i gave him two doses", "i gave
  // my son a double dose", "she was given the whole bottle"); "too much" after
  // "gave" is not food ("i gave the baby too much milk" is not a dose)
  new RegExp(String.raw`${GAVE}${RECIPIENT} ${GIVEN_EXCESS}`),
  new RegExp(String.raw`${GAVE}${RECIPIENT} ${TOO_OR_SO}${NOT_MEDICINE_AFTER}${NOT_CHILD_FOOD}`),
  // review round 4: an adult dose given to someone ("i gave my son the adult
  // dose"), and two caregivers who each gave a dose ("we both gave him his medicine")
  new RegExp(
    String.raw`${GAVE}${RECIPIENT} (?:the |an? |his |her |their )?(?:full )?(?:adult|grown[- ]?up)(?:'s|s'?)? (?:dose|dosage|amount|strength|tablets?|pills?|version|one|syrup|medicine)\b`,
  ),
  new RegExp(
    String.raw`\b(?:both|each|all) (?:gave|given|administered)${RECIPIENT} (?:(?:a |an |the |his |her |their |my |our )?(?:[\w']+ )?(?:dose|doses|medicine|medication|meds|pills?|tablets?|syrup|spoonful)\b|(?:it|them|one) to\b)`,
  ),
  // review round 4: too much was given or taken ("too much syrup was given to
  // my son", "too many pills were swallowed"), but not a time ("too much time
  // was taken")
  new RegExp(
    String.raw`\b${TOO_OR_SO}${NOT_MEDICINE_AFTER}(?: [\w']+){0,3}? (?:was|were|got|has been|have been|had been|may have been|might have been) (?:given|taken|swallowed|consumed|drunk|eaten|used|administered|ingested)\b`,
  ),
  // review round 4: a dose that was too much, in the passive ("a double dose
  // was given", "two doses were given", "10 ml was given"), but not a time
  // ("the 2 pm dose was given"); one more dose only by mistake ("another dose
  // was given by mistake"), as in the active form
  // review round 5: also a size word or a multiple ("a large dose was given",
  // "twice the dose was given")
  new RegExp(
    String.raw`\b(?:${TOO_MUCH}|(?:${COUNT_WORD_2PLUS}|(?:[2-9]|[1-9]\d+)(?:\.\d+)?)${NOT_MEDICINE_AFTER}|an? ${SIZE_INTENS}${SIZE_WORD}|${MULTIPLE} (?:the|my|his|her|their))(?: [\w']+){0,2}? (?:doses?|pills?|tablets?|capsules?|caplets?|spoonfuls?|teaspoons?|tablespoons?|ml|mg|sachets?|amounts?|quantit(?:y|ies))\b (?:was|were|got|has been|have been|had been|may have been|might have been) (?:given|taken|swallowed|administered)\b`,
  ),
  new RegExp(
    String.raw`\b${ANOTHER}(?: ${EXTRA_DOSE_NOUN})? (?:was|were|got|has been|had been|may have been|might have been) (?:given|taken|swallowed|administered)\b(?: [\w']+){0,3}? ${BY_MISTAKE}\b`,
  ),
  new RegExp(
    String.raw`\b${BY_MISTAKE},? (?:[\w']+ ){0,3}?${ANOTHER}(?: ${EXTRA_DOSE_NOUN})? (?:was|were|got|has been|had been|may have been|might have been) (?:given|taken|swallowed|administered)\b`,
  ),
  // review round 4: the amount taken or given was too much ("the dose i took
  // was too high", "the amount i gave him was too much")
  new RegExp(
    String.raw`\b(?:dose|doses|dosage|amount|quantity) (?:that |which )?(?:i|he|she|we|they|you|(?:my|his|her|their|the) [\w']+) (?:took|had|used|swallowed|drank|got|gave${RECIPIENT}|was given) (?:was|were|is|are|might have been|may have been|seems?|seemed) (?:(?:way|far|much|a bit|a little|probably|definitely) )?(?:too (?:high|big|large|much|strong|great)|more than|over|above|double|twice)\b`,
  ),
  // review round 4: way more with no "than" ("i took way more"), but not a time
  // or a photo ("i took way more photos")
  new RegExp(
    String.raw`${TOOK_VERB}(?: ${TAKEN_THING})? (?:way|far|much|a lot|lots|loads|a bunch|so much|so many|many) more\b(?! than\b)${NOT_MEDICINE_AFTER}`,
  ),
  // review round 4: a tablespoon measured instead of a teaspoon
  /\b(?:tablespoons?|tbsps?|tablespoonfuls?)\b(?: [\w']+){0,4}? instead of (?:a |an |one |the |his |her |my )?(?:teaspoons?|tsps?|teaspoonfuls?)\b/,
  // review round 4: asking whether the dose taken or given was too much ("is
  // the dose i took too high?")
  new RegExp(
    String.raw`\b(?:is|was|are|were) (?:the|that|this|my|his|her) (?:dose|doses|dosage|amount|quantity) (?:that |which )?(?:i|he|she|we|they|you|(?:my|his|her|their|the) [\w']+) (?:took|had|used|swallowed|drank|got|gave${RECIPIENT}|was given) (?:(?:way|far|much|a bit|a little) )?too (?:high|big|large|much|strong|great)\b`,
  ),
  // review round 4: what was left ("i took what was left of the pills"), but
  // not food ("i ate what was left of the rice")
  new RegExp(
    String.raw`(?:${TOOK_VERB}|${NOT_PASSIVE}\b${INGESTED_FOOD}${PARTICLE}) (?:all )?(?:what(?:ever)?|all that) (?:was|is|were|'s) left\b(?! of (?:the |my |his |her |their |our )?(?:${FOOD_MOD} )?${ADULT_FOOD}\b)`,
  ),
  // review round 4: too much put in the mouth or a bottle ("i squirted too
  // much in his mouth", "i put too much in his bottle"), not in a coffee
  new RegExp(
    String.raw`\b(?:put|poured|measured|squirted|drew up|added|mixed|gave)(?: (?:in|out|up))? (?:(?:${INTENSIFIER}|(?:too|so) much),? ){0,3}(?:too|so) much (?:in|into|inside) (?:his|her|their|the|my|our|its) (?:[\w']+ )?(?:mouth|bottle|syringe|dropper|spoon|medicine cup|dosing cup)\b`,
  ),
  // review round 4: doubling over time ("i've been doubling my dose", "i keep
  // doubling up"), going overboard, overusing
  /\b(?:been|keep|keeps|kept|am|i'm|im|is|are|was|were|he's|hes|she's|shes) (?:doubling|tripling|quadrupling|double[- ]?dosing)\b/,
  /\b(?:went|gone) overboard\b/,
  /\boverus(?:ed|ing)\b/,
  // review round 4: a bigger dose ("i took a higher dose", "i took too high a
  // dose", "i gave him a bigger dose", "i had a higher dose than the label says")
  new RegExp(String.raw`${TOOK_VERB} ${BIGGER_DOSE}`),
  new RegExp(String.raw`${NOT_PASSIVE}\b${INGESTED_FOOD}${PARTICLE} ${BIGGER_DOSE_FOOD}`),
  // review round 5: a large amount, or a cup or glass, of a thing that is not
  // food ("i took a large dose", "i swallowed a large number of pills", "i drank
  // a large amount of cough syrup", "i drank a cup of cough syrup", "i gave him
  // a big dose"); without a recipient, "gave" needs a dose or a thing ("i gave
  // a large amount to charity" is not one)
  new RegExp(String.raw`${NOT_PASSIVE}\b${INGESTED}${PARTICLE} ${SIZE_EXCESS}`),
  new RegExp(String.raw`${GAVE}${RECIPIENT_REQ} ${SIZE_EXCESS}`),
  // the subject of "was given" is the recipient ("he was given a large amount")
  new RegExp(String.raw`\b(?:was|were|been|got|get|gets) given ${SIZE_EXCESS}`),
  new RegExp(
    String.raw`(?:${NOT_PASSIVE}\b${INGESTED_FOOD}${PARTICLE}|${GAVE}) ${SIZE_EXCESS_FOOD}`,
  ),
  // review round 5: twice or double the dose after a food or drink verb ("i
  // had twice the dose", "i drank double what the label says", "i had twice as
  // much as the label says"); after "ate" a plain amount is food
  new RegExp(
    String.raw`${NOT_PASSIVE}\b(?:drank|drunk|had|(?:ended|wound) up (?:having|drinking))${PARTICLE} ${MULTIPLE_OF}`,
  ),
  new RegExp(
    String.raw`${NOT_PASSIVE}\b(?:ate|eaten|(?:ended|wound) up eating)${PARTICLE} ${MULTIPLE_OF_ATE}`,
  ),
  // review round 5: a second thing taken after a food or drink clause ("i had
  // too much cake and too many pills", "i drank too much tea and medicine", "i
  // had a beer and too many pills"), but not a normal dose ("and took my pills")
  new RegExp(
    String.raw`${NOT_PASSIVE}\b${INGESTED_FOOD}${PARTICLE} (?:(?:${INTENSIFIER}|(?:too|so) much),? ){0,3}(?:too|so) (?:much|many)(?: [\w'-]+,?){0,3}?${AND_ALSO} ${SECOND_MEDICINE}`,
  ),
  new RegExp(
    String.raw`${NOT_PASSIVE}\b(?:${INGESTED}|${INGESTED_FOOD})${PARTICLE}(?: [\w'-]+,?){1,5}?${AND_ALSO} ${SECOND_EXCESS}`,
  ),
  // review round 5: binging on a medicine ("i binged on my sleeping pills")
  new RegExp(
    String.raw`\b(?:binged|overindulged|loaded up)(?: (?:on|in|with))? (?:(?:the|my|his|her|their|some|all|of|these|those) ){0,3}(?:${OBJECT_WORD} ){0,2}?${MEDICINE_WORD}`,
  ),
  // review round 5: not knowing how much was taken ("i don't know how many i
  // took", "i've lost count of the pills i took", "i took some, not sure how
  // many"), but not how much to take, how much is left, or food or drink ("how
  // much wine i had")
  new RegExp(
    String.raw`\b(?:${UNSURE}(?: (?:of|about|exactly|really))? how (?:many|much)(?: (?!${NOT_MEDICINE}\b|${FOOD_PHRASE_WITH})[\w'-]+){0,3}?|lost (?:count|track) of (?:(?:the|my|his|her|their|all) )?(?:[\w'-]+ ){0,2}?${MEDICINE_WORD}(?: (?:that|which))?) (?:i|he|she|we|they|you|someone|(?:my|his|her|their|the|our) [\w'-]+)(?:'ve|'d|'s| have| has| had)?(?: (?:might|may|could|must) (?:have|'ve))?(?: (?:already|actually|really|just))? (?:took|taken|had|swallowed|drank|drunk|ate|eaten|used|consumed|popped|chewed|gave|given|got)\b(?! to (?:drink|eat)\b)`,
  ),
  new RegExp(
    String.raw`\b(?:${INGESTED}|${INGESTED_FOOD}|gave)\b(?: (?!${NOT_MEDICINE}\b|${FOOD_PHRASE_WITH})[\w'-]+){0,5}?,? (?:(?:and|but|so) )?(?:i'?m |i am |i )?${UNSURE}(?: (?:of|about|exactly))? how (?:many|much)\b(?! (?:to|i (?:can|should|could|may|might)|(?:[\w'-]+ )?(?:is|are|was|were) (?:left|in|still))\b)`,
  ),
  // review round 5: over what the label or the prescription says ("i exceeded
  // my prescription", "i exceeded what the label says", "i went beyond the
  // directions"), but not going over the directions (reading them) or a
  // storage limit ("the temperature exceeded what the label says")
  new RegExp(
    String.raw`${NOT_STORAGE}\b(?:exceeded|surpassed|overshot|went (?:beyond|above|past)|gone (?:beyond|above|past)|${BE_PERSON} ${OVER}) ${THAN_WHAT}${THAN_LABEL}(?! (?:temperature|temp|storage|heat|humidity|light|shelf|for (?:the )?(?:storage|temperature))\b)`,
  ),
  // review round 5: most of it after an ingestion verb ("i took most of
  // them"); after a food or drink verb "most of it" is food
  new RegExp(
    String.raw`${NOT_PASSIVE}\b${INGESTED}${PARTICLE} (?:most|nearly all|almost all|the majority|the bulk) of (?:it|them|these|those)\b`,
  ),
  // review round 5: a child after eating or swallowing a medicine ("my son is
  // acting weird after eating my pills"), and an empty medicine container next
  // to a child ("i found my toddler with an empty bottle of children's
  // tylenol", "there is an empty blister pack next to the baby")
  new RegExp(
    String.raw`\b${CHILD_S}\b(?: [\w'-]+){0,8}? (?:after|since|from) (?:eating|swallowing|drinking|chewing|licking|sucking on|biting|getting into) ${CHILD_OBJECT}\b${NOT_CHILD_FOOD}`,
  ),
  new RegExp(
    String.raw`\b${CHILD_S}\b(?: [\w'-]+){0,6}? (?:(?:an?|the|my|his|her|their|our) )?${EMPTY_CONTAINER}`,
  ),
  new RegExp(
    String.raw`\b${EMPTY_CONTAINER}(?: [\w'-]+){0,6}? (?:(?:the|my|his|her|their|our|a) )?${CHILD}\b`,
  ),
  // review round 4: too much over time or while taking it ("i've been taking
  // too many", "i keep taking more than the label says", "am i taking too
  // much?"); review round 5: also after the fact ("i feel sick after taking
  // too much tylenol"; not a count: "can i drive after taking two tablets?")
  // and asked about ("did i take twice the dose?", "did i take a big dose?")
  new RegExp(
    String.raw`(?:\b${ONGOING} ${TAKING}|${AFTER_TAKING}|${DID_TAKE})(?: (?:it|them|one|${TAKEN_DOSE}))? ${EXCESS_TAIL}`,
  ),
  // "i took it twice", "he took his pills twice today", "i had my dose twice";
  // review round 4: "i gave him his medicine twice", "i gave it to him twice"
  new RegExp(String.raw`${TOOK_VERB}(?: ${TAKEN_THING})?${TO_SOMEONE} ${REPEATED}`),
  new RegExp(String.raw`${NOT_PASSIVE}\b${INGESTED_FOOD} ${TAKEN_THING} ${REPEATED}`),
  // review round 2: "i took more than the label says", "i took one more than i
  // should"; review round 3: "i took more pills than i should", "more of it
  // than", "more than what the label says", "more than twice the dose"; review
  // round 4: "i took higher than the recommended dose", "i gave my daughter
  // more than the label says", "i took my dose more than once today"
  new RegExp(
    String.raw`${NOT_IT}${TOOK_VERB}${MORE_PREFIX} ${MORE_WORD}${MORE_NOUN} than (?:${THAN_WHAT}${THAN_LABEL}|${THAN_USUAL}|${THAN_WHAT}${THAN_PERSON}|${THAN_MULTIPLE}|enough\b|once\b(?! (?:a|per|each|every) (?:day|night|week|morning|evening)\b| (?:daily|nightly|weekly)\b))`,
  ),
  // after a food or drink verb only the label form: "i had more than the
  // recommended dose", but not "i ate more than usual" or "...than i should"
  new RegExp(
    String.raw`${NOT_PASSIVE}${NOT_IT}\b${INGESTED_FOOD}${MORE_PREFIX} ${MORE_WORD} than ${THAN_WHAT}${THAN_LABEL}`,
  ),
  // review round 3: with a dose noun a food verb is not food ("i had more pills than i should")
  new RegExp(
    String.raw`${NOT_PASSIVE}${NOT_IT}\b${INGESTED_FOOD}${MORE_PREFIX} ${MORE_WORD}${MORE_DOSE} than (?:${THAN_WHAT}${THAN_LABEL}|${THAN_USUAL}|${THAN_WHAT}${THAN_PERSON}|${THAN_MULTIPLE})`,
  ),
  // review round 3: "i exceeded the dose", "i took over the limit", "she went
  // over the maximum"; review round 5: not a storage subject ("the temperature
  // exceeded the maximum")
  new RegExp(String.raw`${NOT_STORAGE}\b${OVER_LIMIT}`),
  // review round 3: asking whether too much was taken ("did i take too much?",
  // "did she take more than the label says?"); review round 4: "did i give him
  // too much?" (review round 5: the other amounts are in the rule above)
  new RegExp(
    String.raw`${DID_TAKE}(?: (?:it|them|one|${TAKEN_DOSE}))? (?:${TOO_OR_SO}|${TOO_MUCH}|more than)`,
  ),
  // review round 3: "i exceeded it", "she overshot that"
  new RegExp(String.raw`${NOT_IT}\b(?:exceeded|surpassed|overshot) (?:it|that|them)\b`),
  // "i took both doses", "she took both of the tablets"; review round 4: "i gave him both doses"
  new RegExp(
    String.raw`(?:${NOT_PASSIVE}\b(?:${INGESTED}|${INGESTED_FOOD})${PARTICLE}|${GAVE}${RECIPIENT}) ${BOTH}`,
  ),
  // review round 3: "i took both of them", "i took them both by accident", "i
  // took both by mistake"; review round 4: "i took the both of them"
  new RegExp(String.raw`${TOOK_VERB} ${BOTH_THEM}`),
  new RegExp(String.raw`${TOOK_VERB} both (?:[\w']+ ){0,3}?${BY_MISTAKE}\b`),
  // one more dose by mistake: "i took another one by mistake", "i
  // accidentally took a second dose", "by mistake, i took another"
  new RegExp(String.raw`${TOOK_ANOTHER} (?:[\w']+ ){0,3}?${BY_MISTAKE}\b`),
  new RegExp(String.raw`\b${BY_MISTAKE},? (?:[\w']+ ){0,3}?${TOOK_ANOTHER}`),
  // a dose taken again: "i took my morning dose again", "i forgot and took it
  // again". Decision: no exclusion, not even "as directed"; the emergency text
  // is conditional, so over-triage is the accepted direction. Review round 4:
  // also given again ("i gave him his dose again").
  new RegExp(String.raw`${TOOK_VERB}(?: ${TAKEN_THING})?${TO_SOMEONE} again\b`),
  new RegExp(String.raw`${NOT_PASSIVE}\b${INGESTED_FOOD} ${TAKEN_DOSE} again\b`),
  // "chugged it", "gobbled them", "downed everything"
  /\b(?:chugged|gobbled|downed|guzzled|wolfed|necked|scoffed|devoured|knocked back|polished off)(?: down| back| off)? (?:it|them|all|everything)\b/,
  // "i doubled my dose", "she od'd", "i might have overdone it"
  /\b(?:doubled|tripled|quadrupled|double[- ]?dosed|overdid|overdone|overdoing|od'?d|oded)\b/,
  // a child got into it, got some, or swallowed something
  new RegExp(
    String.raw`\b${CHILD_S} ${CHILD_GAP}(?:${CHILD_ACCESS}|got to|got (?:some|one|it|them))\b`,
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
