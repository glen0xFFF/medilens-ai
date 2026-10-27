import { describe, expect, test } from 'vitest';
import {
  ALLOWED_QUESTION_EXAMPLES,
  classifyQuestion,
  REFUSAL_TEXT,
  type AllowedIntent,
  type RefusalReason,
} from '../../src/domain/safety';

/**
 * Task 5b: the gate is default-deny. Refusal patterns run first and win; a
 * question is allowed only when the whole normalised question matches an
 * explicit allow template; everything else is refused as outside_label.
 */

const REFUSE: [question: string, reason: RefusalReason][] = [
  ['How many should I take for my headache?', 'personal_dose'],
  ['my mom is 70kg how many tablets', 'personal_dose'],
  ['How much should I give him?', 'personal_dose'],
  ['I weigh 50 kilos, what dose is right?', 'personal_dose'],
  ['My dad is 80 years old, how many per day?', 'special_population'],
  ['Ilang tableta ang iinumin ko?', 'personal_dose'],
  ['Can I give this to my 3 year old?', 'special_population'],
  ['Is it safe while pregnant?', 'special_population'],
  ['Can I take this while breastfeeding?', 'special_population'],
  ['Is this ok for my baby?', 'special_population'],
  ['Pwede ba ito sa buntis?', 'special_population'],
  ['Can I take it with ibuprofen?', 'interaction'],
  ['Can I drink alcohol with this?', 'interaction'],
  ['Does it interact with my blood pressure pills?', 'interaction'],
  ['Should I stop taking it?', 'start_stop'],
  ['Can I switch to another brand?', 'start_stop'],
  ['When should I start taking this?', 'start_stop'],
  ['What is this white round pill?', 'pill_identification'],
  ['Can you identify this tablet?', 'pill_identification'],
  ['What pill is this?', 'pill_identification'],
  ['Do I have a fever if my head is hot?', 'diagnosis'],
  ['What are my symptoms caused by?', 'diagnosis'],
  ['Will this cure my cough?', 'diagnosis'],
  ['Is this safe for me?', 'personal_safety'],
  ['IS IT SAFE?', 'personal_safety'],
  ["I'm allergic to penicillin, is that a problem?", 'personal_safety'],
  ['Can I use this?', 'personal_safety'],
  // review round 1: dosing or suitability for someone else
  ['Can my husband take two at once?', 'personal_dose'],
  ['Can she take it?', 'personal_safety'],
  ['Can my wife take this?', 'personal_safety'],
  ['Should my grandma take this?', 'special_population'],
  // review round 1: personal quantity
  ['Is 3 tablets too much?', 'personal_dose'],
  ['Is 4 tablets a day okay?', 'personal_dose'],
  ["What's the maximum I can take?", 'personal_dose'],
  ['What is the dose per kg?', 'personal_dose'],
  ['Would 1000 mg be fine for me?', 'personal_dose'],
  ['Mg per kg?', 'personal_dose'],
  // review round 1: overdose (Task 5b: ingestion phrasing is possible_overdose)
  ['I took 5 tablets, will I be ok?', 'possible_overdose'],
  ['I accidentally took too many', 'possible_overdose'],
  ['What happens if I take more than the label says?', 'personal_dose'],
  // review round 1: suitability for a condition
  ['Is it ok with my high blood pressure?', 'personal_safety'],
  ['I have diabetes, can this be used?', 'personal_safety'],
  ['Can this be taken by diabetics?', 'personal_safety'],
  // review round 2: suitability for me or someone else
  ['Is it suitable for me?', 'personal_safety'],
  ['Is it suitable for my father?', 'personal_safety'],
  ['Would my mom be okay taking this?', 'personal_safety'],
  ['Is this for my dad too?', 'personal_safety'],
  // review round 2: personal quantity with a bare count
  ['Is 3 a day ok?', 'personal_dose'],
  ['Is three okay?', 'personal_dose'],
  ['Is 2 enough?', 'personal_dose'],
  ['How about 3 a day?', 'personal_dose'],
  ['My husband wants to take 2, fine?', 'personal_dose'],
  ['What if my wife takes two?', 'personal_dose'],
  ['Can I double up?', 'personal_dose'],
  // review round 2: overdose without "took" (Task 5b: possible_overdose)
  ['I swallowed 6 of these', 'possible_overdose'],
  ['I ate the whole pack, what now?', 'possible_overdose'],
  // review round 3: overdose phrasings without "took" (Task 5b: possible_overdose)
  ["I've taken 10", 'possible_overdose'],
  ['I have taken 8 today', 'possible_overdose'],
  ['I had eight', 'possible_overdose'],
  ['I popped 5', 'possible_overdose'],
  ['I used 6 today', 'possible_overdose'],
  ['I downed the bottle', 'possible_overdose'],
  ['I finished the pack in a day', 'possible_overdose'],
  ['I swallowed a bunch', 'possible_overdose'],
  ['I ate a lot of them', 'possible_overdose'],
  // review round 3: personal quantity frequency phrasings
  ['Is twice a day enough?', 'personal_dose'],
  ['3x a day?', 'personal_dose'],
  ['3/day?', 'personal_dose'],
  ['3 daily?', 'personal_dose'],
  ['Take an extra one?', 'personal_dose'],
  ['Can I triple it?', 'personal_dose'],
  // review round 3: suitability phrasings
  ['Is it appropriate for me?', 'personal_safety'],
  ['Is this meant for adults like me?', 'personal_safety'],
  // review round 4: structural gate. Any quantity, frequency or administration
  // token refuses as personal_dose, whatever the verb or phrasing.
  // Task 5b: reported ingestion of an amount is possible_overdose.
  ['I gobbled 5', 'possible_overdose'],
  ['I chugged the bottle', 'possible_overdose'],
  ['I consumed 12', 'possible_overdose'],
  ['I had a few', 'possible_overdose'],
  ['I had a handful', 'possible_overdose'],
  ['I ate a handful', 'possible_overdose'],
  ['I doubled my dose', 'possible_overdose'],
  ['one more?', 'personal_dose'],
  ['Another one?', 'personal_dose'],
  ['Another dose now?', 'personal_dose'],
  ['Is a second dose ok?', 'personal_dose'],
  ['Can I quadruple it?', 'personal_dose'],
  ['Is twice daily enough?', 'personal_dose'],
  ['Every hour?', 'personal_dose'],
  ['4 in a day?', 'personal_dose'],
  ['Half a tablet?', 'personal_dose'],
  ['Can I split it?', 'personal_dose'],
  ['Can I crush it?', 'personal_dose'],
  // review round 4: more members of the same class, not from the finding
  ['I inhaled 3', 'possible_overdose'],
  ['I wolfed down the whole strip', 'possible_overdose'],
  ['Once every 2 hours?', 'personal_dose'],
  ['Repeat it again tonight?', 'personal_dose'],
  ['A couple?', 'personal_dose'],
  ['Can I chew it?', 'personal_dose'],
  ['I consumed 1000', 'possible_overdose'],
  // decision: a token inside a printed instruction still refuses (over-refusal accepted)
  ['What does "do not crush" mean?', 'personal_dose'],
  // review round 4: structural gate. A first-person subject with a suitability
  // word, or with a medicine-use verb outside a label-reading form, refuses.
  ['Would this work for me?', 'personal_safety'],
  ['Is this the right medicine for me?', 'personal_safety'],
  ['Should I be taking this?', 'personal_safety'],
  ['Is this for me?', 'personal_safety'],
  ['Is this good for us?', 'personal_safety'],
  ['Which one is better for my body?', 'personal_safety'],
  ['When do I take it?', 'personal_safety'],
  ['Am I using it right?', 'personal_safety'],
  // decision: a label-reading form does not rescue a suitability word
  ['What does the label say, would it work for me?', 'personal_safety'],
  // review round 4: a first-person question refuses whatever its verb, unless it
  // is a label-reading or request form
  // round 5: now caught earlier by the dose-change and continuation gates
  ['Could I up it?', 'personal_dose'],
  ['Would it be bad for me?', 'personal_safety'],
  ['Is this what I need?', 'personal_safety'],
  ['Can my body handle it?', 'personal_safety'],
  ['Is it strong enough for me?', 'personal_safety'],
  ['I knocked back the pack', 'possible_overdose'],
  ['Any harm if I keep going?', 'personal_dose'],
  ['Do you recommend it?', 'personal_safety'],
  ['Bedtime too?', 'personal_dose'],
  ['Morning and night?', 'personal_dose'],
  // review round 5 (c): overdose with a third-person subject or no subject
  // (Task 5b: possible_overdose)
  ['He gobbled the bottle', 'possible_overdose'],
  ['She chugged the syrup', 'possible_overdose'],
  ['Someone swallowed a strip', 'possible_overdose'],
  ['Chugged it', 'possible_overdose'],
  ['Gobbled them', 'possible_overdose'],
  ['Downed the lot', 'possible_overdose'],
  // review round 5 (a): a dose lexeme or dose-change verb outside a label-reading form
  ['Up the dose?', 'personal_dose'],
  ['Increase the dose?', 'personal_dose'],
  ['Can the dose be raised?', 'personal_dose'],
  ['Is a bigger dose ok?', 'personal_dose'],
  ['Is a stronger dose ok?', 'personal_dose'],
  ['Is a higher amount fine?', 'personal_dose'],
  ['Redose?', 'personal_dose'],
  ['Re-dose ok?', 'personal_dose'],
  ['Repeat?', 'personal_dose'],
  ['Can it be repeated?', 'personal_dose'],
  ['Top up?', 'personal_dose'],
  ['How soon can it be retaken?', 'personal_dose'],
  ['Skipped a dose, now what?', 'personal_dose'],
  ['Dose?', 'personal_dose'],
  ['Dosage?', 'personal_dose'],
  // review round 5 (b): glued counts, clinical abbreviations, timing and administration
  ['Every 4h?', 'personal_dose'],
  ['q6h?', 'personal_dose'],
  ['BID?', 'personal_dose'],
  ['TID ok?', 'personal_dose'],
  ['2x?', 'personal_dose'],
  ['x2?', 'personal_dose'],
  ['2tabs?', 'personal_dose'],
  ['Before sleep?', 'personal_dose'],
  ['For how long?', 'personal_dose'],
  ['A week?', 'personal_dose'],
  ['A quarter?', 'personal_dose'],
  ['Quarter tablet?', 'personal_dose'],
  ['Is a quarter tablet ok?', 'personal_dose'],
  ['Dissolve it?', 'personal_dose'],
  ['Can it be dissolved in water?', 'personal_dose'],
  ['Can the capsule be opened?', 'personal_dose'],
  ['With food?', 'personal_dose'],
  ['Empty stomach?', 'personal_dose'],
  ['After eating?', 'personal_dose'],
  ['Continue?', 'personal_dose'],
  ['Keep going?', 'personal_dose'],
  // review round 5 (d): suitability with no subject and no label noun
  ['Will this work?', 'personal_safety'],
  ['Is this the right medicine?', 'personal_safety'],
  ['Is this right for a fever?', 'personal_safety'],
  ['Is it enough?', 'personal_safety'],
  ['Too strong?', 'personal_safety'],
  ['Ought it be taken?', 'personal_safety'],
  ['Would you take this?', 'personal_safety'],
  ['What would you do?', 'personal_safety'],
  // review round 5: more members of the same classes, not from the finding
  // (Task 5b: a child swallowing something is possible_overdose)
  ['My son gulped the jar', 'possible_overdose'],
  ['They swallowed all of it', 'possible_overdose'],
  ['Can he have it?', 'personal_safety'],
  ['Would it help her?', 'personal_safety'],
  ['Lower the dose?', 'personal_dose'],
  ['Reduce it?', 'personal_dose'],
  ['Missed one yesterday', 'personal_dose'],
  ['3 caps ok?', 'personal_dose'],
  ['Every 8 hrs?', 'personal_dose'],
  ['PRN?', 'personal_dose'],
  ['Sprinkle on food?', 'personal_dose'],
  ['Open the capsule?', 'personal_dose'],
  ['Before meals?', 'personal_dose'],
  ['Does it work?', 'personal_safety'],
  ['Is it effective?', 'personal_safety'],
  ['If you were me?', 'personal_safety'],
  // review round 5: elliptical use, timing and suitability with no subject,
  // found by probing after the first green
  ['Take it now?', 'personal_dose'],
  ['Right away?', 'personal_dose'],
  ['Today?', 'personal_dose'],
  ['Tomorrow too?', 'personal_dose'],
  ['Overnight?', 'personal_dose'],
  ['Chug it?', 'personal_safety'],
  ['Eat first?', 'personal_safety'],
  ['Worth taking?', 'personal_safety'],
  ['Can a dog have it?', 'personal_safety'],
  ['Pets?', 'personal_safety'],
  ['Is it strong?', 'personal_safety'],
  ['Strong enough?', 'personal_safety'],
  ['Works?', 'personal_safety'],
  ['Effective?', 'personal_safety'],
  ['Any good?', 'personal_safety'],
  ['Which is better?', 'personal_safety'],
  ['Is this one better?', 'personal_safety'],
  ['Is it for headaches?', 'personal_safety'],
  ['When will it kick in?', 'personal_safety'],
  ['Drive after?', 'personal_safety'],
  ['Food first?', 'personal_dose'],
  ['Lessen it?', 'personal_dose'],
  ['Halve it?', 'personal_dose'],
  ['Less?', 'personal_dose'],
  ['Fewer?', 'personal_dose'],
  ['A spoonful?', 'personal_dose'],
  ['Alternate days?', 'personal_dose'],
  ['Monthly?', 'personal_dose'],
  ['Ok?', 'personal_safety'],
  ['Fine?', 'personal_safety'],
  ['Is it bad?', 'personal_safety'],
  ['Still good after expiry?', 'personal_safety'],
  ['Expired yesterday, still ok?', 'personal_safety'],
  ['5ml?', 'personal_dose'],
];

/** Every probe from the Task 5 round-5 re-review. None matches an allow template. */
const ROUND_5_PROBES: [question: string, reason: RefusalReason][] = [
  ['How often?', 'outside_label'],
  ['Days?', 'outside_label'],
  ['Till when?', 'outside_label'],
  ['Bump it?', 'outside_label'],
  ['Finish the bottle?', 'outside_label'],
  ['All of it?', 'outside_label'],
  ['The lot?', 'outside_label'],
  ['Inject?', 'outside_label'],
  ['Under the tongue?', 'outside_label'],
  ['In juice?', 'outside_label'],
  ['With aspirin?', 'outside_label'],
  ['Both?', 'outside_label'],
  // decision: lethality questions get the emergency text, not a pharmacist redirect
  ['Lethal?', 'possible_overdose'],
  ['Can it kill?', 'possible_overdose'],
  ['Is it appropriate?', 'outside_label'],
  ['Substitute?', 'outside_label'],
  ['Generic ok?', 'outside_label'],
  ['Is it the same as Biogesic?', 'outside_label'],
  ['What would a doctor say?', 'outside_label'],
  ['Yes or no?', 'outside_label'],
  // a label-reading form does not rescue third-person dose talk
  ['According to the label, should she increase the dose?', 'personal_dose'],
  ['What does the label say, should he redose?', 'personal_dose'],
  ['What does it say, can she up it?', 'personal_dose'],
  ['Fever?', 'outside_label'],
  ['Does it cure covid?', 'outside_label'],
  ['Would you take this?', 'personal_safety'],
  ['Does it work?', 'personal_safety'],
  ['Is it fake?', 'outside_label'],
];

/**
 * Task 5b review round 1 (finding 1): the quoted and unquoted phrase slots of
 * "what does ... mean" share one grammar: at most 6 words and 60 characters,
 * with no pronoun, modal, question word, or verdict, claim or amount word.
 * Invisible characters are stripped before any pattern runs, and a look-alike
 * letter outside ASCII is never allowed.
 */
const PHRASE_SLOT_PROBES: [question: string, reason: RefusalReason][] = [
  // the reviewer's probes
  ['What does "you should take as many as you need" mean?', 'outside_label'],
  ['What does "you dont need a doctor" mean?', 'outside_label'],
  ['What does "you can take it till you feel better" mean?', 'outside_label'],
  ['What does "increase if needed" mean?', 'outside_label'],
  ['What does "give it to a puppy" mean?', 'outside_label'],
  ['What does "it works for covid" mean?', 'outside_label'],
  ['What does "this is a fake" mean?', 'outside_label'],
  ['What does "biogesic is the same thing" mean?', 'outside_label'],
  // zero-width spaces are stripped, so the pregnancy pattern sees "safe while pregnant"
  ['What does "is it s\u200Bafe while pr\u200Begnant" mean?', 'special_population'],
  // Cyrillic look-alike letters (U+043E, U+0430) are not ASCII
  ['What does "h\u043Ew m\u0430ny sh\u043Euld I t\u0430ke" mean?', 'outside_label'],
  // more members of the class: each phrase has one stop word and nothing else that refuses
  ['What does "fake" mean?', 'outside_label'],
  ["What does 'counterfeit product' mean?", 'outside_label'],
  ['What does "genuine medicine" mean?', 'outside_label'],
  ['What does "real medicine" mean?', 'outside_label'],
  ['What does "same as biogesic" mean?', 'outside_label'],
  ['What does "cures covid" mean?', 'outside_label'],
  ['What does "works for covid" mean?', 'outside_label'],
  ['What does "whenever needed" mean?', 'outside_label'],
  ['What does "as much as wanted" mean?', 'outside_label'],
  ['What does "doctor optional" mean?', 'outside_label'],
  ['What does "give to a puppy" mean?', 'outside_label'],
  // found by probing after the first green: sameness and verdict words
  ['What does "identical to biogesic" mean?', 'outside_label'],
  ['What does "equivalent to biogesic" mean?', 'outside_label'],
  ['What does "harmless" mean?', 'outside_label'],
  ['What does "unsafe" mean?', 'outside_label'],
  ['What does "use freely" mean?', 'outside_label'],
  // a negated modal without its apostrophe is a modal; an apostrophe is not a phrase character
  ['What does "dont exceed" mean?', 'outside_label'],
  ['What does "shouldnt exceed" mean?', 'outside_label'],
  ['What does "don\'t exceed" mean?', 'outside_label'],
  // the unquoted slot has the same grammar
  ['What does fake mean?', 'outside_label'],
  ['What does same as biogesic mean?', 'outside_label'],
  ['What does cures covid mean?', 'outside_label'],
  ['What does the phrase genuine medicine mean?', 'outside_label'],
  // at most 6 words
  ['What does "keep in a cool dry place always" mean?', 'outside_label'],
  // a Cyrillic look-alike (U+0435) inside an otherwise allowed quoted phrase
  ['What does "k\u0435ep dry" mean?', 'outside_label'],
];

/**
 * Task 5b review round 2 (finding 1): a joining character between letters
 * ('-', '.', '/', '+', '&', '%') no longer carries a stop word through the
 * phrase slot. A phrase word is letters and digits; '.' and '-' join digits
 * only ("0.5", "2-8"), plus a short list of whole label terms ("non-drowsy").
 * The registration-number slot of the registry template takes only the
 * registry's own formats (DR-, DR-XY, DRHR-, DRP- then digits).
 */
const JOINED_WORD_PROBES: [question: string, reason: RefusalReason][] = [
  // the reviewer's probes
  ['What does "x-you-should-take-as-many-as-you-need" mean?', 'outside_label'],
  ['What does "a.you.can.take.many" mean?', 'outside_label'],
  ['What does "1/you/dont/need/a/doctor" mean?', 'outside_label'],
  ['What does "x-fake" mean?', 'outside_label'],
  ['What does "a-counterfeit" mean?', 'outside_label'],
  ['What does "non-fake" mean?', 'outside_label'],
  ['What does "f-a-k-e" mean?', 'outside_label'],
  // more members of the class: every joining character, both quote forms, unquoted
  ['What does "fa-ke" mean?', 'outside_label'],
  ['What does "f.a.k.e" mean?', 'outside_label'],
  ['What does "x/fake" mean?', 'outside_label'],
  ['What does "x+fake" mean?', 'outside_label'],
  ['What does "x&fake" mean?', 'outside_label'],
  ['What does "x%fake" mean?', 'outside_label'],
  ["What does 'x-fake' mean?", 'outside_label'],
  ['What does x-fake mean?', 'outside_label'],
  ['What does the word non-genuine mean?', 'outside_label'],
  ['What does "keep-dry-you-need-no-doctor" mean?', 'outside_label'],
  // the same hole in the registration-number slot of the registry template
  ['Is dr-1-fake registered?', 'outside_label'],
  ['Is DR-123-counterfeit in the registry?', 'outside_label'],
];

/**
 * Third-person modal plus dose talk refuses even inside a label-reading form,
 * exactly as the first-person form already did (that one keeps its Task 5
 * reason, personal_safety).
 */
const MODAL_DOSE_TALK: [question: string, reason: RefusalReason][] = [
  ['According to the leaflet, should they lower it?', 'personal_dose'],
  ['What does the label say, should his mother reduce it?', 'personal_dose'],
  ['What does the label say, must they repeat it?', 'personal_dose'],
  ['According to the label, she should take it?', 'personal_dose'],
  ['According to the box, my wife can up it?', 'personal_dose'],
  ['What does it say about how I should take it?', 'personal_dose'],
  ['What does the label say, should I redose?', 'personal_safety'],
];

const OVERDOSE: string[] = [
  // the brief's table
  'I swallowed 6 of these',
  'My kid ate some',
  'The baby ate one',
  'My toddler got into the bottle',
  'I took the whole pack',
  'I think I took too much',
  // more members of the same class
  'My daughter swallowed a tablet',
  'My child drank the syrup',
  'The kids got into the medicine cabinet',
  'I took 6 by mistake',
  'She has taken too many',
  'He overdosed',
  'I think my husband took the whole bottle',
  'What if I took too much?',
  'Overdose?',
  'Can you die from it?',
  'Is the baby ok if she swallowed one?',
  'I took them all',
  'I swallowed the whole thing',
  'I took the rest of the bottle',
  'She took the entire blister pack',
  'I took the rest of the pills',
  'My kid ate the rest of the pills',
  // Task 5b review round 1 (finding 2): a child named by age, "got some",
  // "chewed on", and too-much phrasing without a count
  'My 2 year old drank some',
  'The baby got some',
  'My toddler chewed on the blister',
  'I took one too many',
  'I took a double dose',
  'I took my dose twice',
  'I took it twice',
  'I took extra',
  'I might have overdone it',
  // more members of the same class
  'My two-year-old swallowed one',
  'My 18 month old ate a tablet',
  'Her 4-year-old drank the syrup',
  'My 3yo got into the pills',
  'My little one swallowed some',
  'The baby got one',
  'My daughter got them',
  'My son sucked on a tablet',
  'I took an extra one',
  'I took double',
  'She took double the dose',
  'I had a double dose',
  'I took twice the dose',
  'He took his pills twice today',
  'I took it three times today',
  'I had my dose twice',
  'I have overdone it',
  // Task 5b review round 2 (finding 2): more than the label or the person
  // allows, one extra, 2x, both doses, a dose again or by mistake, and a child
  // with medicine in the mouth
  'I took more than the label says',
  'I took more than I should have',
  'I took one more than I should',
  'I took 1 extra',
  'I took it 2x',
  'I took both doses',
  'I took another one by mistake',
  'I took a second dose by mistake',
  'I took it again by accident',
  'I took my morning dose again',
  'I forgot and took it again',
  'The baby put one in his mouth',
  'The baby put it in her mouth',
  // more members of the same class
  'I took way more than I should',
  'I took a bit more than the label says',
  'She took more than the directions say',
  'I took more than recommended',
  'I took more than one',
  'I had more than the recommended dose',
  'I took one extra',
  'I took it x2',
  'I took both of the tablets',
  'I accidentally took another one',
  'By mistake, I took a second dose',
  'He accidentally took his pills again',
  'I took the evening dose again',
  'My toddler put a pill in her mouth',
  'The baby has a tablet in his mouth',
  'My son put the capsule in his mouth',
  // found by probing after the first green
  'I took more than the maximum',
  'The baby was chewing on a pill',
  'My son is sucking on a tablet',
  'The baby is eating the pills',
  // decision: no exclusion for a dose taken "again", even "as directed"; the
  // emergency text is conditional, so over-triage is the accepted direction
  'I took it again today as directed',
  // Task 5b review round 3 (finding 1): an intensifier before "too much", a
  // noun or "what" around "more than", over-limit verbs, "both of them", and
  // "one of my pills" in a child's mouth
  'I took way too much',
  'I took way too many',
  'I took far too many',
  'I took much too much',
  'I swallowed way too many pills',
  'I think I took way too much',
  'She took way too much of it',
  'I took more pills than the label says',
  'I took more tablets than I should',
  'I took more medicine than I should',
  'I took more doses than the label says',
  'I took more of it than I should',
  'I took more than what the label says',
  'I took more than what I should',
  'I took over the limit',
  'I exceeded the dose',
  'I took both of them by mistake',
  'The baby put one of my pills in his mouth',
  'The baby put one of the tablets in her mouth',
  // more members of the same class
  'I took a little too much',
  'I took slightly too many',
  'I have taken way too much',
  'He may have taken far too many',
  'I took way more pills than I should have',
  'I took more of my pills than the doctor prescribed',
  'I took more sleeping pills than I should',
  'I had more pills than the label says',
  'I took more than is recommended',
  "I took more than what's recommended",
  'I took more than the recommended daily dose',
  'I took more than the doctor prescribed',
  'I took more than twice the dose',
  'I exceeded the recommended dose',
  'I exceeded the daily limit',
  'She went over the maximum',
  'I went over the recommended dose',
  'I took above the recommended dose',
  'I took both of them',
  'I took them both by accident',
  'The baby put some of the tablets in his mouth',
  "My toddler put one of grandma's pills in her mouth",
  'The baby has one of my capsules in his mouth',
  'My son is putting pills in his mouth',
  // found by probing after the first green
  'I took more than whats on the label',
  'Did I exceed the dose?',
  'I took both',
  'She took both of those',
  "My son put one of his sister's pills in his mouth",
  // Task 5b review round 3 (finding 2): a food word that does not end the
  // clause, or a medicine word later in the sentence, is not food
  'My son drank some milk of magnesia',
  'My son drank some of the milk of magnesia',
  'My kid ate some fruit flavored gummies',
  'My kid ate some fruit gummies',
  'My kid ate some fruit flavoured chewable tablets',
  'My son drank some fruit punch flavored syrup',
  'My son drank some of the juice flavored medicine',
  'My daughter had some fruit syrup',
  'My daughter drank some tea with my pills dissolved',
  'The baby drank some of the water with the tablet in it',
  'My toddler ate some food with my pills',
  'The baby ate some food from the pill box',
  'The baby drank some juice and some pills',
  // more members of the same class
  'My kid ate some rice and some vitamins',
  'My son drank some water with the medicine in it',
  'The baby drank some juice mixed with my syrup',
  'My toddler ate some fruit and then some of my meds',
  // found by probing after the first green: the medicine or a second
  // ingestion comes in the next sentence
  'My daughter ate some fruit. Then she took my pills',
  'My son drank some milk. He took one too',
  // found by a second probe sweep: repeated intensifiers, "so many", a free
  // noun or "this" between "more" and "than", "than the label" with no verb,
  // "more than enough", being over a limit, an amount before "limit", "both"
  // with a time or two named doses, possessive children and "one of them"
  'I took way, way too much',
  'I took far far too many',
  'I took so many',
  'I took so much of it',
  'I took one or two too many',
  'I took more than enough',
  'I took more of this than I should',
  'I took more of this medicine than I should',
  'I took more paracetamol than I should',
  'I took more than I could handle',
  'I took more than the label',
  'I took more than the directions',
  'I exceeded it',
  'I passed the limit',
  "I'm over the daily limit",
  "I think I'm over the limit",
  'She is way over the max',
  'I went over the 4g limit',
  'I went over the 4000 mg daily limit',
  'I exceeded the 8 tablet limit',
  'I went way over the limit',
  'I took well over the recommended dose',
  'I took both at once',
  'I took both together',
  'I took both my morning and evening dose',
  'I took both of my meds',
  'I found the baby with a pill in his mouth',
  "The baby's got a pill in his mouth",
  "My son's chewing a pill",
  'The baby put one of those in his mouth',
  'The baby put some of them in his mouth',
  'My kid put a couple of them in his mouth',
  "There is a pill in the baby's mouth",
  'The baby has something in his mouth from the pill box',
  // found by a second probe sweep: after the food word comes a second thing
  // taken, an access verb, or "medicated"; only a new clause keeps it food
  'My son drank some milk and some Fevrex',
  'My son drank some milk and Fevrex',
  'The baby drank some juice and some of it',
  'My kid ate some rice and the whole strip',
  'My son drank some juice and half the bottle',
  'My son ate some bread and two of these',
  'My son drank some milk then some more',
  'My son drank some milk, some syrup',
  'My son drank some medicated milk',
  'The baby ate some fruit, then got into my purse',
  'The baby ate some food and then grabbed the bottle',
  // third probe sweep: asking whether too much was taken
  'Did I take too much?',
  'Did she take way too many?',
  'Did I take more than the label says?',
  "My son put a pill in the baby's mouth",
  // fourth probe sweep: a count or "some" before the dose noun
  'My daughter put some pills in her mouth',
  'The baby put two tablets in his mouth',
  // Task 5b review round 4 (finding 1): "too much" plus a medicine after a food
  // or drink verb, a bigger dose, a "number of" or "allowance" limit, an
  // owner's pill in a child's mouth, and "the two of them"
  'I drank too much of this syrup',
  'She drank too much cough syrup',
  'I had too much medicine',
  'I had too much paracetamol',
  'I had too much of it',
  'My son drank too much of the syrup',
  'My son drank way too much syrup',
  'The baby drank too much of the medicine',
  'My son had too much of the syrup',
  'I took a higher dose than the label says',
  'I took a bigger dose',
  'I took a larger dose than I should',
  'I took too high a dose',
  'I took too large a dose',
  'I took a stronger dose than I should',
  'I took higher than the recommended dose',
  'I exceeded the recommended number of tablets',
  'I went over the recommended number of pills',
  'I took over the daily allowance',
  "The baby put grandma's pill in his mouth",
  "The baby put his sister's tablet in his mouth",
  'I took the two of them',
  // more members of the same class, found by a probe sweep before the fix.
  // After a food or drink verb, a word after "too much" that is not food, drink
  // or time fails closed (a brand name, "of it"); a child who drank or ate too
  // much is not asked what
  'I drank too much syrup',
  'I have drunk too much of the medicine',
  'I had too much of my medicine',
  'I had too much Tylenol',
  'I drank too much Fevrex',
  'I had too much of this',
  'I ate too much of the gummies',
  'I had so much syrup',
  'I drank far too much of the medicine',
  'I had too much of the drops',
  'I had too much of the syrup last night',
  'I had too much milk of magnesia',
  'My daughter had too much medicine',
  'The baby had too much of it',
  'My toddler drank too much Fevrex',
  'He drank too much of his cough syrup',
  'My son drank too much',
  'The baby drank too much',
  // decision: candy is not food for a child (review round 2), so "too much
  // candy" keeps the emergency text
  'My son ate too much candy',
  // a bigger dose said another way
  'I took a much higher dose',
  'I took a dose that was too high',
  'I took a dose higher than recommended',
  'I took a dose too large',
  'I took a too high dose',
  'I took too big of a dose',
  'I took too strong a dose',
  'I took a greater dose than prescribed',
  'I took a huge dose',
  'I took an excessive amount',
  'I took a larger amount than recommended',
  'She took a higher dose than the doctor said',
  'I had a higher dose than the label says',
  'I took higher doses than recommended',
  'I took larger doses',
  'I took a higher dosage',
  'I used a higher dose',
  'I took a stronger dose',
  'I took higher than recommended',
  'I took larger than the recommended dose',
  'I took way higher than the recommended dose',
  'I took my dose more than once today',
  // a "number of", "allowance" or "intake" limit
  'I exceeded the number of doses',
  'I exceeded the daily allowance',
  'I exceeded the recommended intake',
  'I exceeded the recommended daily intake',
  'I went over the daily intake',
  "I've gone over the recommended number of doses",
  "I'm over the daily allowance",
  'She exceeded the recommended number of capsules',
  'I took more than the recommended number of tablets',
  'I took more than the allowed number of doses',
  'I took more than the daily allowance',
  // an owner's medicine, or a modifier with no determiner, swallowed or in the mouth
  "The baby put my mom's pills in her mouth",
  "The toddler put grandpa's heart pill in his mouth",
  "My son put daddy's medicine in his mouth",
  'The baby put my blood pressure pill in his mouth',
  "The baby had grandma's pill in his mouth",
  "My son ate grandma's pill",
  "My son swallowed his sister's tablet",
  "The baby swallowed grandma's pills",
  "My toddler chewed grandpa's capsule",
  "My son took his brother's medicine",
  "My son drank his sister's cough syrup",
  "The baby ate the neighbor's pills",
  "The baby ate grandma's blood pressure pills",
  'My son ate heart pills',
  // a count after "the", "my" or "the last"; "the both of them"; "a pair of them"
  'I took the three of them',
  'I took the 2 of them',
  'I took the two pills',
  'I took the three tablets',
  'I took the two doses',
  'I took the last two pills',
  'I took the last 3 tablets',
  'My son ate the two of them',
  'The baby put the two of them in his mouth',
  'I took the both of them',
  'I took a pair of them',
  // a caregiver gave too much: "gave", "given" (also passive), "fed", "did i give"
  'I gave my son too much syrup',
  'I gave him too much',
  'I gave the baby too much medicine',
  'My wife gave the baby too much medicine',
  'I fed the baby too much syrup',
  'My son was given too much syrup',
  'He was given a double dose',
  'I may have given him too much',
  'I think I gave her too many',
  'Did I give him too much?',
  'I gave her two doses',
  'I gave him 2 doses by mistake',
  'I gave him a double dose',
  'I gave him an extra dose by mistake',
  'I gave him another dose by mistake',
  'I accidentally gave him twice the dose',
  'I gave him his medicine twice',
  'I gave him his dose again',
  'I gave her the whole bottle',
  'I gave him both doses',
  'I gave my daughter more than the label says',
  'I gave the baby a higher dose than recommended',
  "I put too much medicine in the baby's bottle",
  // too much taken over time, or asked about while taking it
  "I've been taking too much",
  'I have been taking too many',
  'I keep taking too many',
  "I've been taking more than the label says",
  "I've been drinking too much cough syrup",
  'Am I taking too much?',
  // found by a probe sweep after the first green: an owner that is also a
  // non-medicine word ("kids'", "children's"), a repeated "too much", "overly"
  // or "very" before "high", an adult dose given to a child, a bare "number",
  // "gave him over", two caregivers, an inverted passive, "the dose i took was
  // too high", "one pill too many", "way more", "ingested", "sipped", a
  // tablespoon for a teaspoon, and a laxative
  "I drank too much of the kids' syrup",
  "I had too much of the children's syrup",
  'I drank too much of the kids syrup',
  'I had too much night time cold medicine',
  'I drank too much, way too much syrup',
  'I drank like too much syrup',
  'My son drank like way too much syrup',
  'I took an overly high dose',
  'I took a dangerously high dose',
  'I took a very large dose',
  'I gave my son the adult dose',
  'I gave the baby an adult dose',
  'I took more tablets than the recommended number',
  'I exceeded the recommended number',
  'I gave him over the recommended dose',
  'My husband and I both gave him a dose',
  'We both gave him his medicine',
  'Too much syrup was given to my son',
  'Too much medicine was taken',
  'Too many pills were swallowed',
  'The dose I took was too high',
  'The amount I gave him was too much',
  'I took one pill too many',
  'I had one pill too many',
  'I took way more',
  'I took way more, is that bad?',
  'I ingested too much',
  'I ingested 10 tablets',
  'I sipped too much of the syrup',
  'I gave him a tablespoon instead of a teaspoon',
  'I used a tablespoon instead of a teaspoon',
  'I ate too much chocolate laxative',
  // found by a third probe sweep: the dose asked about, "overboard", the rest
  // or what was left, a whole sheet, "got his hands on", an unknown amount,
  // too much put in the mouth or bottle, doubling, overusing, and a count
  // before an owner or kind of medicine ("3 children's tablets")
  'Is the dose I took too high?',
  'Was the amount I gave him too much?',
  'I went overboard with the pills',
  'I took the rest',
  'I drank the rest of it',
  'I took what was left of the pills',
  'I took the leftover pills',
  'I took a whole sheet of pills',
  'My son got his hands on my pills',
  'My toddler ate an unknown amount',
  'My son drank an unknown amount of the syrup',
  'I squirted too much in his mouth',
  'I put too much in his bottle',
  "I've been doubling my dose",
  'I keep doubling up',
  'I overused my inhaler',
  "I took too many kids' tablets",
  "I took 3 children's tablets",
  'I took two kids tablets',
  'My wife and I both gave it to him',
  'I took a spoonful too many',
  // a final sweep of variants of the reviewer's probes: an intensifier before
  // "too high a dose", a child by age or possessive, a perfect tense, "my
  // daily allowance", a household product before water
  'I took way too high a dose',
  'My 3yo drank too much of the medicine',
  "My daughter's had too much of the syrup",
  "He's taken a larger dose than he should",
  'I took over my daily allowance',
  'My son drank some cleaning water',
  // a dose that was too much, said in the passive
  'A double dose was given',
  'Two doses were given by mistake',
  'An extra dose was taken',
  '10 ml was given instead of 5',
  'Another dose was given by mistake',
  'By mistake a second dose was given',
  // Task 5b review round 4 (finding 2): only a closed list of food modifiers
  // makes a child's drink or food plain food; any other word before it (a
  // household product, a brand name, "laced", "cough") keeps the emergency text
  'My son drank some bleach water',
  'The baby drank some soapy water',
  'My toddler drank some soap water',
  'My son drank some antifreeze juice',
  'My son drank some Fevrex juice',
  'The baby drank some Fevrex water',
  'The baby drank some of my Fevrex tea',
  'My son drank some of the Fevrex water',
  'My son drank some laced juice',
  'My son drank some spiked juice',
  'My son drank some cough juice',
  // more members of the same class
  'My son drank some kerosene water',
  'The baby drank some herbal tea',
  'My son ate some Fevrex rice',
  // Task 5b review round 5 (finding 1): a plain size word before an amount, an
  // amount of a medicine after a food or drink verb, "twice" after a food or
  // drink verb, a food word that does not end its phrase ("sugar free cough
  // syrup") or a second thing taken after it, a cup or glass of a medicine,
  // "quantity" and "number of ml" limits, a hyphenated owner, "the pair of them"
  'I took a large amount of pills',
  'I swallowed a large number of pills',
  'I took a large quantity of tablets',
  'I took a large dose',
  'I took a big dose',
  'I took a big handful',
  'I drank a large amount of cough syrup',
  'I drank a huge amount of syrup',
  'I had an excessive amount of syrup',
  'I drank a big amount of the syrup',
  'I drank a larger amount of syrup than recommended',
  'I had a larger amount than recommended',
  'I drank a bigger amount than the label says',
  'I had twice the dose',
  'I drank twice the dose',
  'I drank twice the recommended dose',
  'I had twice the recommended amount',
  'I drank double the amount',
  'I had twice as much as the label says',
  'I drank too much sugar free cough syrup',
  'I had too much sugar-free syrup',
  'I drank too much sugar free syrup',
  'I had too much cake and too many pills',
  'I had too much alcohol and too many pills',
  'I drank too much tea and medicine',
  'I had too much juice and medicine',
  'My son drank a cup of the syrup',
  'My son drank a glass of cough syrup',
  'My son drank half a cup of the medicine',
  'The baby drank a big gulp of the syrup',
  'I drank a cup of cough syrup',
  'I drank a whole glass of the syrup',
  'I exceeded the recommended quantity',
  'I went over the recommended quantity',
  'I took more than the allowed quantity',
  'I exceeded the recommended number of tablespoons',
  'I went over the recommended number of ml',
  "My son swallowed my mother-in-law's pill",
  "My son ate my mother-in-law's tablets",
  "The baby put my mother-in-law's pill in his mouth",
  "The baby put my step-mom's pill in her mouth",
  'I took the pair of them',
  'I took the both',
  // more members of the same class, found by a probe sweep before the fix: other
  // size words, verbs and nouns; an amount of a brand name; a multiple of what the
  // label says; a brand name after a food modifier; a second excess after any
  // food or drink clause; other vessels and a child's capful, shot or swig; other
  // limit words and what the prescription says; owners and step-children; "em"
  'I took a large amount',
  'I took a huge number of pills',
  'I took a high dose',
  'I took a heavy dose of my sleeping pills',
  'I swallowed a big handful of pills',
  'I took a substantial amount of it',
  'I took a dangerous amount of pills',
  'I took a crazy amount of paracetamol',
  'I took large doses',
  'She took a very large number of tablets',
  'He may have taken a big dose',
  'I consumed a large quantity of the gummies',
  'I took a great deal of the syrup',
  'I took an unknown amount',
  'I took a large single dose',
  'I took a large amount of Fevrex',
  'I gave him a big dose',
  'I gave my son a large amount of the syrup',
  'I gave her a high dose',
  'I drank a large amount of the medicine',
  'I had a huge amount of it',
  'I drank a big amount of Fevrex',
  'I had a large number of pills',
  'I ate a large number of the gummies',
  'I drank an enormous quantity of cough syrup',
  'She drank a larger amount of the syrup than recommended',
  'I had a big dose',
  'I had a high dose',
  'I drank large amounts of the syrup',
  'I had a dangerous amount of my sleeping pills',
  'I had twice my normal dose',
  'I drank twice the maximum',
  'I had double what the label says',
  "I drank twice what's recommended",
  'I ate twice the recommended dose',
  'I had twice as much syrup as the label says',
  'She drank double the recommended amount',
  'I drank double the amount of syrup',
  "I've been taking twice the dose",
  'Did I take twice the dose?',
  'I had too much sugar-free cough syrup',
  'I drank too much sugar free Fevrex',
  'I ate too much chocolate Ex-Lax',
  'I had too much wine and too many sleeping pills',
  'I drank too much beer, and some pills',
  'I had too much coffee plus too many pills',
  'I had too much cake as well as two tablets',
  'I had a beer and too many pills',
  'I drank too much wine and too much Tylenol',
  'I had too much alcohol and all my pills',
  'I drank a mug of cough syrup',
  'I drank two cups of the syrup',
  'I had a glass of the medicine',
  'I drank half a cup of Fevrex',
  'She drank a whole cup of the cough medicine',
  'I gave him a cup of the syrup',
  'I swallowed a big gulp of the syrup',
  'My daughter drank a mug of the medicine',
  'My toddler had a capful of the syrup',
  'My 3 year old drank a shot of the cough syrup',
  'The baby took a swig of the medicine',
  'My son drank a bottleful of the syrup',
  'I exceeded the recommended number of mg',
  'I exceeded the recommended number of puffs',
  'I exceeded the daily quantity',
  'I took more than the safe limit',
  'I exceeded the upper limit',
  'I exceeded the suggested dose',
  'I went over the 24 hour limit',
  'I took more than the right dose',
  'I exceeded my prescription',
  'I exceeded what the label says',
  'I went beyond the directions',
  "I'm over the recommended quantity",
  "My son swallowed my mother in law's pill",
  "The baby swallowed my grandparents' blood pressure pills",
  "My toddler chewed his great-grandma's pills",
  "My son drank my brother-in-law's cough syrup",
  "My stepson swallowed my mom's pills",
  'My little boy ate some of my pills',
  'My stepdaughter ate some',
  'I took the pair',
  'I took a pair',
  'I swallowed both of em',
  "I took both of 'em",
  'I gave him the pair of them',
  // other ingestion verbs, a misspelt "accidentally", an unknown amount taken,
  // and a size word or multiple while taking it, asked about or in the passive
  'I tossed back a handful of pills',
  'I threw back the whole bottle',
  'I scarfed down too many gummies',
  'I crunched 4 tablets',
  'I binged on my sleeping pills',
  'I dosed myself with 3 tablets',
  'I self-medicated with too many pills',
  'I ended up taking too many',
  'I ended up taking the whole pack',
  'I ended up having way too much syrup',
  'I accidently took another one',
  'I accidently took a second dose',
  "I don't know how many I took",
  "I'm not sure how many pills I took",
  'I lost count of how many I took',
  "I can't remember how many I took",
  'Not sure how much I took',
  "I don't know how much syrup she drank",
  'No idea how many he swallowed',
  'I took some, not sure how many',
  "She drank some of it, I don't know how much",
  'I took an unknown number of pills',
  "I've been taking large doses",
  'Did I take a big dose?',
  'A large dose was given',
  'Twice the dose was given',
  // found by a probe sweep after the first green: "quite a few", "plenty of"
  // a medicine, a labelled amount after "ate", "the label dose", servings, a
  // pint, a child's bowl or shot glass, binge verbs, "sucked on", "was given"
  'I took quite a few',
  'I swallowed plenty of pills',
  'I ate twice the amount on the label',
  'I ate double the amount the label says',
  'I went over the label dose',
  'I exceeded the recommended serving',
  'I took more than the recommended servings',
  'I drank a pint of cough syrup',
  'My son drank a pint of the syrup',
  'The baby ate a bowl of the gummies',
  'My toddler drank a shot glass of the syrup',
  'I binged on too many',
  'I overindulged in way too many pills',
  'I loaded up on the whole pack',
  'I sucked on too many',
  'I chewed on 3 tablets',
  'He was given a large amount',
  // a contracted perfect after "how many", the pills counted, and servings
  "I don't know how many I've taken",
  "Not sure how many she's taken",
  'I lost count of the pills I took',
  "I'm over the recommended servings",
  // a second sweep of the wider class: being over what the label says, part or
  // most of a container, "a little extra", too much reported after taking it, a
  // child after eating pills or next to an empty medicine container, "out of
  // the syrup bottle", and an extra dose after a normal one
  "I'm over what the label says",
  "She's way over what the doctor prescribed",
  'I drank a quarter of the bottle',
  'I drank a third of the bottle',
  'I took most of the pills',
  'I took most of them',
  'I swallowed most of the pack',
  'I took a good chunk of the bottle',
  'I drank a big part of the bottle',
  'I took a little extra',
  'I took a bit extra',
  'I gave him a little extra',
  'I feel sick after taking too much Tylenol',
  'I feel dizzy after taking too many pills',
  'I threw up after taking a large dose',
  "Is it bad that I'm dizzy after taking double the dose",
  'My son is acting weird after eating my pills',
  "I found my toddler with an empty bottle of children's Tylenol",
  'My son was holding an empty pill bottle',
  'There is an empty blister pack next to the baby',
  'My toddler drank out of the syrup bottle',
  'I took my dose and an extra dose',
  'I took my pill and a double dose',
  // a third sweep (subject, hedge and suffix variants of the reviewer's probes):
  // a bare "both" followed by a time
  'I took the both last night',
  'I took both yesterday',
  'I took both this morning',
  // a fourth sweep: more quantity idioms and size words, a dose noun or "what i
  // usually take" after a multiple, a brand name after a counted second object,
  // "a cup full of", "a half cup", and counted shots of a medicine
  'I took a boatload of pills',
  'I took a pile of pills',
  'I took a mega dose',
  'I took a megadose of vitamin D',
  'I took a stupid amount of pills',
  'I had twice as many pills as I should',
  'I ate twice as many gummies as I should',
  'I drank double what I usually take',
  'I had too much vodka and a bunch of Xanax',
  'I had too much vodka and 2 Xanax',
  'I drank a cup full of cough syrup',
  'I drank a glass full of the medicine',
  'I drank a half cup of cough syrup',
  'I took 2 shots of NyQuil',
];

/** Counts, food, drink and passive questions that are not a report of too much taken. */
const NOT_OVERDOSE: [question: string, reason: RefusalReason][] = [
  ['I took one an hour ago, can I take another?', 'personal_dose'],
  ['Is it used 3 times a day?', 'personal_dose'],
  ['Can it be taken 2 at a time?', 'personal_dose'],
  ['It took 2 hours to work', 'personal_dose'],
  ['I had 2 beers, can I take it?', 'personal_dose'],
  ['I ate too much, can I take it?', 'personal_dose'],
  ['My kid swallowed a coin', 'special_population'],
  ['My son had a fever, can he take it?', 'special_population'],
  ['I took the full dose, can I take more?', 'personal_dose'],
  ['I took the full amount', 'personal_dose'],
  ['I finished the whole course', 'personal_safety'],
  // review round 1: a schedule, a food or drink idiom, or a product variant is not too much taken
  ['I took it twice a day for a week', 'personal_dose'],
  ['I used it twice daily', 'personal_dose'],
  ['Is it taken twice a day?', 'personal_dose'],
  ['I had one too many last night, can I take it?', 'personal_dose'],
  ['I had extra rice, can I take it now?', 'personal_safety'],
  ['I ate twice today, can I take it?', 'personal_safety'],
  ['I took extra care to keep it dry', 'personal_dose'],
  ['I took the extra strength one', 'personal_dose'],
  ['I took the double strength one', 'personal_dose'],
  ['My 2 year old has a fever, can she take it?', 'special_population'],
  ['My son got a fever, can he take it?', 'special_population'],
  // review round 2: time, a passive form, a photo, a hand in the mouth, a food
  // idiom and a scheduled second dose are not too much taken
  ['It took more than an hour to work', 'personal_dose'],
  ['It took more than one day to work', 'personal_dose'],
  ['Can it be taken again after 4 hours?', 'personal_safety'],
  ['I took a photo again', 'personal_dose'],
  ['The baby put his hand in his mouth', 'special_population'],
  ['I ate more than I should, can I take it?', 'personal_safety'],
  ['I took my second dose at noon', 'personal_dose'],
  ['I took another photo by mistake', 'personal_dose'],
  ['By mistake I took another picture', 'personal_dose'],
  // a child eating or drinking food is not an ingestion of medicine
  ['My child is drinking some water, can I give it?', 'special_population'],
  ['My daughter is eating some rice, can she take it after?', 'special_population'],
  ['My son drank some milk, can he take it now?', 'special_population'],
  // review round 3: food that ends the clause with no medicine word after it,
  // an intensified food idiom, time and photos are not too much taken
  ['My kid ate some fruit', 'special_population'],
  ['My daughter ate some rice and fell asleep', 'special_population'],
  ['The baby drank some of the water, is that ok?', 'special_population'],
  ['My son drank some juice then went to bed, can he take it?', 'special_population'],
  ['I ate way too much, can I take it?', 'personal_dose'],
  ['I took way too many photos', 'personal_dose'],
  ['I took far too much time to read it', 'personal_dose'],
  ['It took way more than an hour to work', 'personal_dose'],
  ['It took over an hour to work', 'personal_dose'],
  ['The box exceeded the maximum temperature', 'personal_dose'],
  ['I went over the dosage instructions with my doctor', 'personal_dose'],
  ['I took both photos', 'personal_dose'],
  ['Did you exceed the limit?', 'outside_label'],
  // second probe sweep: a food word followed by a new clause stays food;
  // "so much" after a food verb, time and storage limits are not too much taken
  ['My son drank some milk and went to sleep', 'special_population'],
  ['My son drank some juice, is that why he is sleepy', 'special_population'],
  ['My son drank some water. Is that ok', 'special_population'],
  ['I ate so much, can I take it?', 'personal_safety'],
  ['I took so much time to read it', 'personal_dose'],
  ['It is over the limit for storage temperature', 'outside_label'],
  // third probe sweep: photos are not a dose
  ['I took more photos than I needed', 'personal_dose'],
  // giving a dose by mouth is a suitability question, not a report
  ["How do I put it in my baby's mouth?", 'special_population'],
  ["Can I put the syrup in my baby's mouth?", 'special_population'],
  ['I took both pictures of the label', 'personal_dose'],
  // review round 4: food after a modifier on the closed food list stays food
  ['My son drank some orange juice', 'special_population'],
  ['My son drank some warm milk', 'special_population'],
  ['The baby drank some breast milk', 'special_population'],
  ['My toddler ate some chicken soup', 'special_population'],
  ['My daughter drank some coconut water, can she take it?', 'special_population'],
  // food, drink, time or a plain clause after "too much" is not a dose
  ['I ate too much pizza, can I take it?', 'personal_dose'],
  ['I drank too much coffee, can I take it?', 'personal_dose'],
  ['I drank too much last night, can I take it?', 'personal_dose'],
  ['I had too much to drink, can I take it?', 'personal_dose'],
  ['I ate too much this morning', 'personal_dose'],
  ['I drank too much water', 'personal_dose'],
  ['I had so much fun', 'personal_safety'],
  ['I drank too much wine, can I take it?', 'interaction'],
  ['I added too much water to the syrup', 'personal_dose'],
  ['I had too much food, can I take it?', 'personal_dose'],
  ['My son drank too much water', 'special_population'],
  ['My daughter ate too much rice and fell asleep', 'special_population'],
  // how a dose is given, a feeding bottle, one dose, a prescription or a supply
  ['Can it be given 2 at a time?', 'personal_safety'],
  ['Is it given twice a day?', 'personal_dose'],
  ['Can it be given twice a day?', 'personal_safety'],
  ['I gave the baby the bottle', 'special_population'],
  ['I gave the baby his bottle, can I give the syrup now?', 'special_population'],
  ['I gave him one, can I give another?', 'personal_safety'],
  ['The doctor gave me two tablets', 'personal_dose'],
  ['The pharmacist gave me the whole box', 'personal_dose'],
  ['I gave birth two weeks ago, can I take it?', 'personal_safety'],
  ['I gave up three days ago', 'personal_dose'],
  // a number after "the" or "my" that is a strength, a time or not a medicine
  ['I gave him the 5 ml dose', 'personal_dose'],
  ['I took the 500 mg one', 'personal_dose'],
  ['I took the 2 pm dose', 'personal_dose'],
  ["I took the 8 o'clock dose", 'personal_dose'],
  ['I took my two kids to the doctor', 'special_population'],
  // a schedule or care while taking it; a stronger product; a question; a negation
  ["I'm taking two a day, is that ok?", 'personal_dose'],
  ["I'm taking extra care with it", 'personal_dose'],
  ['I keep taking it every morning', 'start_stop'],
  ['I took the stronger one', 'personal_dose'],
  ['Is a higher dose ok?', 'personal_dose'],
  ['My son had no medicine today', 'special_population'],
  // found by the probe sweep after the first green: a food modifier, a photo, a
  // time, a drink, a food idiom, a smaller measure and a smaller dose
  ['My son drank some sugar water', 'special_population'],
  ['I took way more photos', 'personal_dose'],
  ['Too much time was taken', 'personal_dose'],
  ['I had one drink too many', 'personal_dose'],
  ['I ate way more than usual, can I take it?', 'personal_safety'],
  ['I gave him a teaspoon instead of a tablespoon', 'personal_dose'],
  ['The dose I took was too low', 'personal_dose'],
  ['I took a very small dose', 'personal_dose'],
  // found by a third probe sweep: benign caregiver, food, time and strength
  // phrasings near the new patterns
  ['We both gave it a try', 'personal_safety'],
  ['I had too much homework so I forgot my dose', 'personal_dose'],
  ['I gave him the 2.5 ml dose', 'personal_dose'],
  ['I took the 500mg one', 'personal_dose'],
  ['I took the rest of the day off', 'personal_dose'],
  ['I took a rest', 'personal_dose'],
  ['I took my 2 weeks of antibiotics', 'personal_dose'],
  ['I had 2 drinks and some pills', 'personal_dose'],
  ['I took 2 kids to get their vitamins', 'special_population'],
  ['I put too much in my coffee', 'personal_dose'],
  ['I put too much sugar in my coffee', 'personal_dose'],
  ['Too much medicine was prescribed', 'personal_dose'],
  ['What happens if too much is taken?', 'personal_dose'],
  ['I gave the baby too much formula', 'special_population'],
  ['I fed the baby too much', 'special_population'],
  ['Is the dose I took ok?', 'personal_dose'],
  ['The dose I took was fine', 'personal_dose'],
  ['My doctor gave me a higher dose', 'personal_dose'],
  ['The pharmacist gave me the adult dose', 'personal_dose'],
  ['I took it more than once a day', 'personal_dose'],
  // a passive that is a schedule, a prescription or a question
  ['A second dose was given at noon', 'personal_dose'],
  ['The 2 pm dose was given', 'personal_dose'],
  ['Two tablets were prescribed', 'personal_dose'],
  ['Can two tablets be taken at once?', 'personal_dose'],
  ['Is a double dose ever given?', 'personal_dose'],
  // review round 5: food or drink in a cup, a glass or a large amount stays food,
  // also with "with" after it
  ['I drank a glass of water', 'personal_safety'],
  ['I drank a cup of coffee', 'personal_safety'],
  ['I had a cup of tea, can I take it?', 'personal_safety'],
  ['I drank a big glass of water', 'personal_safety'],
  ['I drank a large glass of water with it', 'personal_safety'],
  ['I had a mug of hot chocolate', 'personal_safety'],
  ['I drank a cup of warm milk', 'personal_safety'],
  ['I drank two cups of coffee, can I take it?', 'personal_dose'],
  ['I had a glass of orange juice', 'personal_safety'],
  ['I had a glass of wine, can I take it?', 'interaction'],
  ['I drank a whole glass of milk', 'personal_safety'],
  ['I drank half a glass of water', 'personal_dose'],
  ['I took it with a glass of water', 'personal_dose'],
  ['I took the tablet with a cup of tea', 'personal_dose'],
  ['I took a glass of water with it', 'personal_dose'],
  ['I ate a large amount of rice', 'personal_safety'],
  ['I drank a huge amount of water', 'personal_safety'],
  ['I drank a large amount of water today', 'personal_dose'],
  ['I ate a big portion of pasta', 'personal_safety'],
  ['I had a large serving of rice', 'personal_safety'],
  ['I ate a large number of cookies', 'personal_safety'],
  ['I had a large coffee, can I take it?', 'personal_safety'],
  ['I had a large meal, can I take it?', 'personal_safety'],
  ['I gave the baby a large amount of milk', 'special_population'],
  ['I gave him a big glass of water', 'personal_safety'],
  ['I gave my son a cup of milk', 'special_population'],
  ['My son drank a cup of milk', 'special_population'],
  ['My son drank a big glass of water', 'special_population'],
  ['The baby drank a cup of warm milk', 'special_population'],
  ['My daughter drank half a cup of juice', 'special_population'],
  ['My son drank a cup of orange juice, can he take it now?', 'special_population'],
  ['My son ate a big bowl of cereal', 'special_population'],
  // a size word that is not an amount taken, or no ingestion at all
  ['I took a big step', 'personal_dose'],
  ['I took a big risk', 'personal_dose'],
  ['I took a large number of photos', 'personal_dose'],
  ['I took a big bite of my sandwich', 'personal_dose'],
  ['I took my high blood pressure pill', 'personal_dose'],
  ['I took the high dose vitamin D', 'personal_dose'],
  ['I took the large print leaflet', 'personal_dose'],
  ['Is a high dose ok?', 'personal_dose'],
  ['Is a large dose safe?', 'personal_safety'],
  ['What is a big dose?', 'personal_dose'],
  ['I gave a large amount to charity', 'personal_safety'],
  ['I gave him a big hug', 'personal_safety'],
  ['I took a big sip of water', 'personal_dose'],
  // decision: the label's own dose measure is not too much for an adult (a
  // capful, a dosing cup, a shot, a spoonful, a plain swig or sip)
  ['I took a capful of the syrup', 'personal_dose'],
  ['I took a capful as directed', 'personal_dose'],
  ['I took a shot of NyQuil', 'personal_safety'],
  ['I took a dosing cup of the syrup', 'personal_dose'],
  ['I took a spoonful of the syrup', 'personal_dose'],
  ['I took a swig of cough syrup', 'personal_dose'],
  ['I took a sip of the syrup', 'personal_dose'],
  // twice or double as a food idiom, or a question about a dose
  ['I ate twice the amount I usually eat, can I take it?', 'personal_safety'],
  ['I ate double the usual amount, can I take it?', 'personal_safety'],
  ['I ate twice as much as usual', 'personal_dose'],
  ['I had twice as much coffee as usual', 'personal_dose'],
  ['I drank twice as much water as usual', 'personal_dose'],
  ['What happens if I take twice the dose?', 'personal_dose'],
  // going over the directions (reading them), a storage limit, a label question
  ['I went over the directions with my pharmacist', 'personal_safety'],
  ['I went over the instructions', 'personal_safety'],
  ['I went over what the label says with my pharmacist', 'personal_safety'],
  ['The temperature exceeded what the label says', 'outside_label'],
  ['It exceeded the storage limit', 'outside_label'],
  ['The room temperature went above the label limit', 'outside_label'],
  ['What is the recommended quantity?', 'personal_safety'],
  ['Does the label say the number of tablets?', 'outside_label'],
  // an owner's thing that is not a medicine; a step-child or a boy with a symptom
  ["My son put grandma's glasses in his mouth", 'special_population'],
  ["My son ate dinner at my mother-in-law's, can he take the syrup?", 'special_population'],
  ["I took my mother-in-law's prescription to the pharmacy", 'personal_dose'],
  ['My stepson has a fever, can he take it?', 'personal_safety'],
  ['My little boy has a cough, can he take it?', 'personal_safety'],
  ['I took a pair of photos', 'personal_dose'],
  ['I took the pair of glasses off', 'personal_dose'],
  // not knowing an amount that was not taken
  ["I'm not sure how many tablets are in the box", 'personal_dose'],
  ["I don't know how much to take", 'personal_dose'],
  ["I'm not sure how many I can take", 'personal_dose'],
  ["I took a photo but I'm not sure how many tablets are left", 'personal_dose'],
  ["I'm not sure how much is left in the bottle", 'personal_dose'],
  ["I don't know how many drinks I had, can I take it?", 'personal_dose'],
  ['I lost count of the days', 'personal_safety'],
  // a normal dose, a forgotten dose or a question after a food or drink clause
  ['I drank too much wine and took my pills', 'interaction'],
  ['I had too much coffee and forgot my medicine', 'personal_dose'],
  ['I drank too much coffee and then took my medicine', 'personal_dose'],
  ['I had too much cake and felt sick', 'personal_dose'],
  ['I drank too much water and my medicine made me dizzy', 'personal_dose'],
  ['I had dinner and my pills', 'personal_safety'],
  ['I had tea and medicine, is that ok?', 'personal_safety'],
  // verbs that do not mean taking it
  ['I tossed 3 pills in the trash', 'personal_dose'],
  ['I threw away the whole bottle', 'personal_dose'],
  ['I put away the pills', 'personal_safety'],
  ['I went through a lot of pain', 'personal_dose'],
  ['I threw back the blanket', 'personal_safety'],
  // found by the sweep after the first green. Decisions: after a food or drink
  // verb a bare large amount or handful is food; "and my pills" after a too-much
  // clause is an interaction question; a plain gulp is one dose; a bowl is food
  // for an adult; a level or a serving of food is not a dose limit
  ['I drank plenty of water', 'personal_dose'],
  ['I took it with plenty of water', 'personal_dose'],
  ['I ate twice the amount', 'personal_dose'],
  ['I drank a large amount', 'personal_safety'],
  ['I ate a big handful', 'personal_dose'],
  ['I had too much alcohol and my pills', 'interaction'],
  ['I took a gulp of the syrup', 'personal_dose'],
  ['I drank a pint of beer', 'interaction'],
  ['I had a bowl of soup', 'personal_safety'],
  ['My son ate a bowl of cereal', 'special_population'],
  ['My blood sugar went over the safe level', 'personal_safety'],
  ['I went over the recommended servings of vegetables', 'personal_safety'],
  ['I loaded up the dishwasher', 'personal_dose'],
  ['I lost count of the pills I have left', 'personal_safety'],
  // the second sweep's guards: most of a day or a meal, a child's drink
  // container, an empty water bottle, a count or a normal dose after "after
  // taking", food after "after eating", a normal second item
  ['I took most of the day off', 'personal_dose'],
  ['I drank most of my coffee', 'personal_safety'],
  ['I ate most of my dinner', 'personal_safety'],
  ['My son drank from my water bottle', 'special_population'],
  ['My son drank from his sippy cup', 'special_population'],
  ['My son keeps playing with an empty water bottle', 'special_population'],
  ["My son's water bottle is empty", 'special_population'],
  ['Can I drive after taking two tablets?', 'personal_dose'],
  ['I feel better after taking it', 'diagnosis'],
  ['I feel sick after eating too much', 'personal_dose'],
  ['I took my dose and my vitamins', 'personal_dose'],
  ['I took a little more water with it', 'personal_dose'],
  ['I took both photos last night', 'personal_dose'],
  ['I took both kids to school', 'special_population'],
  // the fourth sweep's guards: people, drinks and food as a second object, a
  // shot of alcohol, a cup full of water
  ['I had too much wine and two friends came over', 'interaction'],
  ['I had 2 beers and 2 shots', 'personal_dose'],
  ['I had a burger and two fries', 'personal_dose'],
  ['I had pizza and 2 slices of cake', 'personal_dose'],
  ['I had 2 shots of tequila', 'personal_dose'],
  ['I drank a cup full of water', 'personal_safety'],
];

const ALLOW: [question: string, intent: AllowedIntent][] = [
  // read_label: the whole label
  ['Can you read this label?', 'read_label'],
  ['Read the label to me', 'read_label'],
  ['Please read the label out loud', 'read_label'],
  ['Could you read it again?', 'read_label'],
  ['What does the label say?', 'read_label'],
  ['What does the pack say about storage?', 'read_label'],
  ['What is printed on the pack?', 'read_label'],
  ['What does the second line say?', 'read_label'],
  ['What does the lower half of the label say?', 'read_label'],
  ['Can you read the right side?', 'read_label'],
  ['Tell me what the label says', 'read_label'],
  // decision (kept from round 5): a label-reading form may name the dose topic
  ['What does the label say about the dose?', 'read_label'],
  // decision (kept from round 4): asking what the label says about frequency
  ['What does the label say about how often to take it?', 'read_label'],
  // read_label: a printed field
  ['What is the brand name?', 'read_label'],
  ['What is the generic name on the box?', 'read_label'],
  ['What is the expiry date on the pack?', 'read_label'],
  ['When does it expire?', 'read_label'],
  ['What is the lot number?', 'read_label'],
  ["What's the batch number?", 'read_label'],
  ['What is the dosage form?', 'read_label'],
  ['What are the ingredients?', 'read_label'],
  ['What is the dose amount printed on the label?', 'read_label'],
  ['What is the registration number on the pack?', 'read_label'],
  ['Who makes this medicine?', 'read_label'],
  ['Who makes it?', 'read_label'],
  ['Who manufactures it?', 'read_label'],
  ['Which one is the brand name?', 'read_label'],
  ['Can you tell me the expiry date?', 'read_label'],
  // explain_text
  ['What does this warning mean?', 'explain_text'],
  ['What does the warning mean in simple words?', 'explain_text'],
  ['Explain the directions in simpler words', 'explain_text'],
  ['Can you explain the warnings?', 'explain_text'],
  ['Simplify the instructions', 'explain_text'],
  ['What does "keep in a cool dry place" mean?', 'explain_text'],
  ["What does 'Rx only' mean?", 'explain_text'],
  ['What does Rx only mean?', 'explain_text'],
  // review round 2: '.' and '-' between digits, a trailing period, and whole label terms
  ['What does "non-drowsy" mean?', 'explain_text'],
  ['What does "film-coated" mean?', 'explain_text'],
  ['What does "0.9% sodium chloride" mean?', 'explain_text'],
  ['What does "store at 2-8" mean?', 'explain_text'],
  ['What does "keep dry." mean?', 'explain_text'],
  ['What does "keep in a cool, dry place" mean?', 'explain_text'],
  ['What does e.g. mean?', 'explain_text'],
  // review round 3: label text about exceeding a dose is not an overdose report
  ['What does the warning about exceeding the dose mean?', 'explain_text'],
  ['What does that mean?', 'explain_text'],
  ['Say that in simpler words', 'explain_text'],
  ['What are the directions?', 'explain_text'],
  ['What do the directions say?', 'explain_text'],
  ['What does the storage instruction say?', 'explain_text'],
  ['How should it be stored?', 'explain_text'],
  ['Tell me more about the warnings', 'explain_text'],
  ['Could you read the directions for me?', 'explain_text'],
  // strength
  ['What strength is printed here?', 'strength'],
  ['What is the strength?', 'strength'],
  ["What's the strength on the label?", 'strength'],
  ['Is it 500 mg?', 'strength'],
  ['How strong is it per tablet according to the label?', 'strength'],
  ['Can you tell me the strength?', 'strength'],
  // unclear_parts
  ['Which parts were unclear?', 'unclear_parts'],
  ['Which parts could you not read?', 'unclear_parts'],
  ["Which parts couldn't you read?", 'unclear_parts'],
  ['What could you not read?', 'unclear_parts'],
  ['What was unclear?', 'unclear_parts'],
  ['Is the bottom half of the label blurry?', 'unclear_parts'],
  ['Is the label cut off?', 'unclear_parts'],
  ['Is the text on the box clear?', 'unclear_parts'],
  ['Is the expiry date clear?', 'unclear_parts'],
  ['Were there any unclear parts?', 'unclear_parts'],
  // registry
  ['What did the FDA registry say?', 'registry'],
  ['What does the registry say?', 'registry'],
  ['Is it registered?', 'registry'],
  ['Is it registered now?', 'registry'],
  ['Is it in the FDA registry?', 'registry'],
  ['Is this medicine registered with the FDA?', 'registry'],
  ['Can you look it up in the registry?', 'registry'],
  ['Is DR-12345 registered?', 'registry'],
  // review round 2: the registry's own formats (DR-XY was refused before)
  ['Is DR-XY12345 registered?', 'registry'],
  ['Is DRP-1234 in the FDA registry?', 'registry'],
  ['Was it found in the registry?', 'registry'],
  // other_label: repeat the last answer
  ['Can you repeat that?', 'other_label'],
  ['Say that again', 'other_label'],
  ['Please repeat that more slowly', 'other_label'],
];

/** No refusal pattern and no allow template: default-deny refuses as outside_label. */
const DEFAULT_DENY: string[] = [
  // allowed (other_label) before Task 5b; no allow template covers them
  'What is it for?',
  'Does it cause drowsiness?',
  'What are the side effects?',
  'Is it expired?',
  'Does it expire in 2027?',
  'How do you take it according to the label?',
  'Can you double check the brand name?',
  "I can't see the expiry date, can you read it?",
  'Can I hear the warnings again?',
  'Can you read me what is printed about using it?',
  // anything else
  'What does it treat?',
  'Is it counterfeit?',
  'Is it real?',
  'Tell me a joke',
  'Who are you?',
  'What is the weather like?',
  'asdf',
  // anchored: an allow template followed by anything else is not the template
  'Can you read this label and tell me if it is fake?',
  'What does the label say? Is it fake?',
  'What is the brand name, and is it any good?',
  'Which parts were unclear, and does it matter?',
];

describe('classifyQuestion refusals kept from Task 5', () => {
  test.each(REFUSE)('%s -> %s', (question, reason) => {
    expect(classifyQuestion(question)).toEqual({ allowed: false, reason });
  });
});

describe('classifyQuestion round-5 re-review probes', () => {
  test.each(ROUND_5_PROBES)('%s -> %s', (question, reason) => {
    expect(classifyQuestion(question)).toEqual({ allowed: false, reason });
  });
});

describe('classifyQuestion printed-phrase slots (review round 1)', () => {
  test.each(PHRASE_SLOT_PROBES)('%s -> %s', (question, reason) => {
    expect(classifyQuestion(question)).toEqual({ allowed: false, reason });
  });

  test('a printed phrase is at most 60 characters, quoted or not', () => {
    const at60 = 'abcdefghij'.repeat(6);
    expect(at60).toHaveLength(60);
    const explain = { allowed: true, intent: 'explain_text' };
    const outside = { allowed: false, reason: 'outside_label' };
    expect(classifyQuestion(`What does "${at60}" mean?`)).toEqual(explain);
    expect(classifyQuestion(`What does "${at60}k" mean?`)).toEqual(outside);
    expect(classifyQuestion(`What does '${at60}' mean?`)).toEqual(explain);
    expect(classifyQuestion(`What does '${at60}k' mean?`)).toEqual(outside);
    expect(classifyQuestion(`What does ${at60} mean?`)).toEqual(explain);
    expect(classifyQuestion(`What does ${at60}k mean?`)).toEqual(outside);
  });

  test('a printed phrase is at most 6 words, quoted or not', () => {
    expect(classifyQuestion('What does "keep in a cool dry place" mean?')).toEqual({
      allowed: true,
      intent: 'explain_text',
    });
    expect(classifyQuestion('What does keep in a cool dry place mean?')).toEqual({
      allowed: true,
      intent: 'explain_text',
    });
    expect(classifyQuestion('What does keep in a cool dry place always mean?')).toEqual({
      allowed: false,
      reason: 'outside_label',
    });
  });
});

describe('classifyQuestion joined words in the free slots (review round 2)', () => {
  test.each(JOINED_WORD_PROBES)('%s -> %s', (question, reason) => {
    expect(classifyQuestion(question)).toEqual({ allowed: false, reason });
  });
});

describe('classifyQuestion modal dose talk inside a label-reading form', () => {
  test.each(MODAL_DOSE_TALK)('%s -> %s', (question, reason) => {
    expect(classifyQuestion(question)).toEqual({ allowed: false, reason });
  });
});

describe('classifyQuestion possible overdose', () => {
  test.each(OVERDOSE)('%s -> possible_overdose', (question) => {
    expect(classifyQuestion(question)).toEqual({ allowed: false, reason: 'possible_overdose' });
  });

  test.each(NOT_OVERDOSE)('%s is not an emergency -> %s', (question, reason) => {
    expect(classifyQuestion(question)).toEqual({ allowed: false, reason });
  });
});

describe('classifyQuestion allowed intents', () => {
  test.each(ALLOW)('%s -> %s', (question, intent) => {
    expect(classifyQuestion(question)).toEqual({ allowed: true, intent });
  });
});

describe('classifyQuestion default-deny', () => {
  test.each(DEFAULT_DENY)('%s -> outside_label', (question) => {
    expect(classifyQuestion(question)).toEqual({ allowed: false, reason: 'outside_label' });
  });
});

describe('ALLOWED_QUESTION_EXAMPLES', () => {
  const PRESETS = [
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

  test('are the canonical preset questions, in order', () => {
    expect(ALLOWED_QUESTION_EXAMPLES).toEqual(PRESETS);
  });

  test.each(PRESETS)('%s is allowed', (question) => {
    expect(classifyQuestion(question).allowed).toBe(true);
  });

  test.each(PRESETS)('%s followed by a dose question is refused', (question) => {
    expect(classifyQuestion(`${question} Should she take more?`).allowed).toBe(false);
    expect(classifyQuestion(`${question} Is it fake?`).allowed).toBe(false);
  });
});

describe('classifyQuestion precedence', () => {
  test('a refusal pattern wins over an allowed label word', () => {
    expect(classifyQuestion('The label says 500 mg, how many should I take?')).toEqual({
      allowed: false,
      reason: 'personal_dose',
    });
    expect(classifyQuestion('Explain the warning: is it safe while pregnant?')).toEqual({
      allowed: false,
      reason: 'special_population',
    });
  });

  test('a refusal pattern wins inside an allow template', () => {
    expect(classifyQuestion('What does "safe for children" mean?')).toEqual({
      allowed: false,
      reason: 'special_population',
    });
    expect(classifyQuestion('What does the label say about alcohol?')).toEqual({
      allowed: false,
      reason: 'interaction',
    });
    expect(classifyQuestion('What does "overdose" mean?')).toEqual({
      allowed: false,
      reason: 'possible_overdose',
    });
    // the Task 5 "what dose" pattern wins over the printed-field template
    expect(classifyQuestion('What dose amount is printed on the label?')).toEqual({
      allowed: false,
      reason: 'personal_dose',
    });
  });

  test('possible_overdose is checked before every other refusal', () => {
    // special_population ("baby") and personal_safety ("ok") would also match
    expect(classifyQuestion('My baby swallowed one, is that ok?')).toEqual({
      allowed: false,
      reason: 'possible_overdose',
    });
  });
});

describe('classifyQuestion normalisation', () => {
  test('is case-insensitive and tolerates curly apostrophes and extra spaces', () => {
    expect(classifyQuestion('  SHOULD   i STOP taking it  ')).toEqual({
      allowed: false,
      reason: 'start_stop',
    });
    expect(classifyQuestion('What’s this white pill?')).toEqual({
      allowed: false,
      reason: 'pill_identification',
    });
    expect(classifyQuestion('  CAN   YOU READ THIS LABEL  ')).toEqual({
      allowed: true,
      intent: 'read_label',
    });
    expect(classifyQuestion('Which parts couldn’t you read?')).toEqual({
      allowed: true,
      intent: 'unclear_parts',
    });
  });

  test('strips trailing punctuation', () => {
    expect(classifyQuestion('Can you read this label?!?')).toEqual({
      allowed: true,
      intent: 'read_label',
    });
    expect(classifyQuestion('What is the brand name ...')).toEqual({
      allowed: true,
      intent: 'read_label',
    });
  });

  test('applies NFKC (full-width characters) and curly double quotes', () => {
    expect(classifyQuestion('Ｃａｎ ｙｏｕ ｒｅａｄ ｔｈｉｓ ｌａｂｅｌ？')).toEqual({
      allowed: true,
      intent: 'read_label',
    });
    expect(classifyQuestion('What does “keep dry” mean?')).toEqual({
      allowed: true,
      intent: 'explain_text',
    });
  });

  test('strips invisible format characters before any pattern runs (review round 1)', () => {
    // soft hyphen, zero-width space, ZWNJ, ZWJ, LRM, RLM, word joiner, BOM,
    // combining grapheme joiner, Mongolian vowel separator
    const invisible = [
      '\u00AD',
      '\u200B',
      '\u200C',
      '\u200D',
      '\u200E',
      '\u200F',
      '\u2060',
      '\uFEFF',
      '\u034F',
      '\u180E',
    ];
    for (const c of invisible) {
      expect(classifyQuestion(`Is it s${c}afe while pr${c}egnant?`)).toEqual({
        allowed: false,
        reason: 'special_population',
      });
      expect(classifyQuestion(`How m${c}any should I t${c}ake?`)).toEqual({
        allowed: false,
        reason: 'personal_dose',
      });
      expect(classifyQuestion(`My b${c}aby swall${c}owed some`)).toEqual({
        allowed: false,
        reason: 'possible_overdose',
      });
      // stripped, not refused: the rest is an allowed question
      expect(classifyQuestion(`Can you read this la${c}bel?${c}`)).toEqual({
        allowed: true,
        intent: 'read_label',
      });
    }
  });

  test('never allows a character outside printable ASCII (review round 1)', () => {
    const outside = { allowed: false, reason: 'outside_label' };
    // Cyrillic look-alikes: U+0430, U+0435
    expect(classifyQuestion('Can you read this l\u0430bel?')).toEqual(outside);
    expect(classifyQuestion('What does "k\u0435ep dry" mean?')).toEqual(outside);
    expect(classifyQuestion("What does 'k\u0435ep dry' mean?")).toEqual(outside);
    // an accented letter, an emoji and a control character
    expect(classifyQuestion('What does "caf\u00E9" mean?')).toEqual(outside);
    expect(classifyQuestion('What does "keep dry \u{1F600}" mean?')).toEqual(outside);
    expect(classifyQuestion('What does "keep\u0007dry" mean?')).toEqual(outside);
  });

  test('a refusal still wins when a non-ASCII character remains (review round 1)', () => {
    // the emergency text is never lost to the ASCII rule
    expect(classifyQuestion('My baby swallowed some \u{1F622}')).toEqual({
      allowed: false,
      reason: 'possible_overdose',
    });
    expect(classifyQuestion('My kid ate some \u2014 help')).toEqual({
      allowed: false,
      reason: 'possible_overdose',
    });
    expect(classifyQuestion('Is it safe while pregnant \u2014 really?')).toEqual({
      allowed: false,
      reason: 'special_population',
    });
  });

  test('refuses an empty question as outside_label', () => {
    for (const q of ['', '   ', '?', ' ?!. ']) {
      expect(classifyQuestion(q)).toEqual({ allowed: false, reason: 'outside_label' });
    }
  });

  test('refuses a question over 300 characters as outside_label before any pattern', () => {
    const at300 = 'How many should I take' + ' x'.repeat(139);
    expect(at300).toHaveLength(300);
    expect(classifyQuestion(at300)).toEqual({ allowed: false, reason: 'personal_dose' });
    expect(classifyQuestion(`${at300}x`)).toEqual({ allowed: false, reason: 'outside_label' });
  });
});

describe('classifyQuestion adversarial input', () => {
  const timed = (q: string) => {
    const start = performance.now();
    const result = classifyQuestion(q);
    return { result, ms: performance.now() - start };
  };

  test.each([
    ['repeated letter', 'a'.repeat(10_000)],
    ['repeated allowed question', 'Can you read this label? '.repeat(400)],
    ['repeated refusal words', 'white round pill take dose '.repeat(371)],
  ])('a 10k-character %s returns within 50 ms and refuses', (_name, q) => {
    expect(q.length).toBeGreaterThanOrEqual(10_000);
    classifyQuestion('warm up');
    const { result, ms } = timed(q);
    expect(result).toEqual({ allowed: false, reason: 'outside_label' });
    expect(ms).toBeLessThan(50);
  });

  test.each([
    ['nested quotes', `what does ${'"a" '.repeat(70)}mean`],
    ['many words before mean', `what does ${'word '.repeat(55)}mean`],
    ['label words then a pill', `${'white label read '.repeat(17)}pill`],
    ['spaces and again', `${'read '.repeat(50)}${'again '.repeat(8)}`],
  ])('a 300-character %s returns within 50 ms', (_name, q) => {
    const input = q.slice(0, 300);
    classifyQuestion('warm up');
    const { ms } = timed(input);
    expect(ms).toBeLessThan(50);
  });
});

describe('REFUSAL_TEXT', () => {
  const REDIRECT = 'Please ask a pharmacist or your doctor.';
  const original: RefusalReason[] = [
    'personal_dose',
    'start_stop',
    'diagnosis',
    'special_population',
    'interaction',
    'personal_safety',
    'pill_identification',
  ];

  test.each(original)('%s ends with the pharmacist redirect', (reason) => {
    const text = REFUSAL_TEXT[reason];
    expect(text.endsWith(REDIRECT)).toBe(true);
    expect(text.length).toBeGreaterThan(REDIRECT.length);
  });

  test('possible_overdose points to emergency care', () => {
    expect(REFUSAL_TEXT.possible_overdose).toBe(
      'If someone may have taken too much of this medicine, call 911 or go to the nearest emergency room now.',
    );
  });

  test('outside_label explains the label-only scope and redirects', () => {
    expect(REFUSAL_TEXT.outside_label).toBe(
      'I can only read and explain what is printed on this label. For questions about whether or how to take it, please ask a pharmacist or your doctor.',
    );
  });

  test('every reason except possible_overdose ends with the redirect', () => {
    const reasons = Object.keys(REFUSAL_TEXT) as RefusalReason[];
    expect(reasons).toHaveLength(9);
    for (const reason of reasons) {
      if (reason === 'possible_overdose') continue;
      expect(REFUSAL_TEXT[reason].toLowerCase().endsWith(REDIRECT.toLowerCase())).toBe(true);
    }
  });
});
