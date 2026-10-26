import { describe, expect, test } from 'vitest';
import { classifyQuestion, REFUSAL_TEXT, type RefusalReason } from '../../src/domain/safety';

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
  // review round 1: overdose
  ['I took 5 tablets, will I be ok?', 'personal_dose'],
  ['I accidentally took too many', 'personal_dose'],
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
  // review round 2: overdose without "took"
  ['I swallowed 6 of these', 'personal_dose'],
  ['I ate the whole pack, what now?', 'personal_dose'],
  // review round 3: overdose phrasings without "took"
  ["I've taken 10", 'personal_dose'],
  ['I have taken 8 today', 'personal_dose'],
  ['I had eight', 'personal_dose'],
  ['I popped 5', 'personal_dose'],
  ['I used 6 today', 'personal_dose'],
  ['I downed the bottle', 'personal_dose'],
  ['I finished the pack in a day', 'personal_dose'],
  ['I swallowed a bunch', 'personal_dose'],
  ['I ate a lot of them', 'personal_dose'],
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
  ['I gobbled 5', 'personal_dose'],
  ['I chugged the bottle', 'personal_dose'],
  ['I consumed 12', 'personal_dose'],
  ['I had a few', 'personal_dose'],
  ['I had a handful', 'personal_dose'],
  ['I ate a handful', 'personal_dose'],
  ['I doubled my dose', 'personal_dose'],
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
  ['I inhaled 3', 'personal_dose'],
  ['I wolfed down the whole strip', 'personal_dose'],
  ['Once every 2 hours?', 'personal_dose'],
  ['Repeat it again tonight?', 'personal_dose'],
  ['A couple?', 'personal_dose'],
  ['Can I chew it?', 'personal_dose'],
  ['I consumed 1000', 'personal_dose'],
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
  ['Could I up it?', 'personal_safety'],
  ['Would it be bad for me?', 'personal_safety'],
  ['Is this what I need?', 'personal_safety'],
  ['Can my body handle it?', 'personal_safety'],
  ['Is it strong enough for me?', 'personal_safety'],
  ['I knocked back the pack', 'personal_safety'],
  ['Any harm if I keep going?', 'personal_safety'],
  ['Do you recommend it?', 'personal_safety'],
  ['Bedtime too?', 'personal_dose'],
  ['Morning and night?', 'personal_dose'],
];

const ALLOW: [question: string, intent: string][] = [
  ['Can you read this label?', 'read_label'],
  ['What is the brand name?', 'read_label'],
  ['What is the expiry date on the pack?', 'read_label'],
  ['What does this warning mean?', 'explain_text'],
  ['Explain the directions in simpler words', 'explain_text'],
  ['What does the storage instruction say?', 'explain_text'],
  ['What strength is printed here?', 'strength'],
  ['How strong is it per tablet according to the label?', 'strength'],
  ['Which parts were unclear?', 'unclear_parts'],
  ['What could you not read?', 'unclear_parts'],
  ['What did the FDA registry say?', 'registry'],
  ['Is it registered?', 'registry'],
  ['Who makes it?', 'other_label'],
  ['I took a photo of the box, can you read it?', 'read_label'],
  // review round 4 guards: the structural gate must not swallow these
  // decision: asking what the label says about frequency is allowed (no count, no first person)
  ['What does the label say about how often to take it?', 'read_label'],
  // decision: a label-reading form rescues a first-person use verb
  ['What does it say about how I should take it?', 'other_label'],
  ['Can you read me what is printed about using it?', 'read_label'],
  // a strength, a registration number or a year is not a count
  ['Is it 500 mg?', 'strength'],
  ['Is DR-12345 registered?', 'registry'],
  ['Does it expire in 2027?', 'read_label'],
  // common words that are not quantities
  ['Can you read it again?', 'read_label'],
  ['Tell me more about the warnings', 'explain_text'],
  ['What does extra strength mean?', 'strength'],
  ['Can you double check the brand name?', 'read_label'],
  ['Which one is the brand name?', 'read_label'],
  ['Can you read the right side?', 'read_label'],
  ['What does the second line say?', 'other_label'],
  ['Is the bottom half of the label blurry?', 'unclear_parts'],
  ['Is the label cut off?', 'read_label'],
  // first-person request and photo forms that ask nothing about use
  ['Could you read the directions for me?', 'explain_text'],
  ["I can't see the expiry date, can you read it?", 'read_label'],
  ['Can I hear the warnings again?', 'explain_text'],
  ['Tell me what the label says', 'read_label'],
];

describe('classifyQuestion refusals', () => {
  test.each(REFUSE)('%s -> %s', (question, reason) => {
    expect(classifyQuestion(question)).toEqual({ allowed: false, reason });
  });
});

describe('classifyQuestion allowed intents', () => {
  test.each(ALLOW)('%s -> %s', (question, intent) => {
    expect(classifyQuestion(question)).toEqual({ allowed: true, intent });
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

  test('is case-insensitive and tolerates curly apostrophes and extra spaces', () => {
    expect(classifyQuestion('  SHOULD   i STOP taking it  ')).toEqual({
      allowed: false,
      reason: 'start_stop',
    });
    expect(classifyQuestion('What’s this white pill?')).toEqual({
      allowed: false,
      reason: 'pill_identification',
    });
  });
});

describe('REFUSAL_TEXT', () => {
  const reasons: RefusalReason[] = [
    'personal_dose',
    'start_stop',
    'diagnosis',
    'special_population',
    'interaction',
    'personal_safety',
    'pill_identification',
  ];
  test.each(reasons)('%s ends with the pharmacist redirect', (reason) => {
    const text = REFUSAL_TEXT[reason];
    expect(text.endsWith('Please ask a pharmacist or your doctor.')).toBe(true);
    expect(text.length).toBeGreaterThan('Please ask a pharmacist or your doctor.'.length);
  });
});
