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
