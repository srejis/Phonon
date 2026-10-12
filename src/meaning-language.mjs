/** Minimal Korean prose guard; does not establish factual or structural correctness. */
const hangulSyllable = /[\uAC00-\uD7A3]/u;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateMeaningLanguage(meaning) {
  const active = new WeakSet();
  const reject = () => {throw new TypeError('Meaning prose must be nonempty Korean text; empty categories use empty arrays.');};
  function prose(value) {
    if (typeof value !== 'string' || !value.trim() || !hangulSyllable.test(value)) reject();
  }
  function proseArray(value) {
    if (!Array.isArray(value)) reject();
    for (const item of value) prose(item);
  }
  function visit(value) {
    if (!isRecord(value) || active.has(value)) reject();
    active.add(value);
    try {
      if (Object.hasOwn(value, 'members')) {
        if (!Array.isArray(value.members)) reject();
        for (const member of value.members) visit(member);
        return;
      }
      for (const section of ['input', 'process', 'output', 'uncertainty']) proseArray(value[section]);
      if (!Array.isArray(value.childUses) || !Array.isArray(value.evidence)) reject();
      for (const use of value.childUses) {
        if (!isRecord(use)) reject();
        prose(use.description);
      }
      for (const evidence of value.evidence) {
        if (!isRecord(evidence)) reject();
        prose(evidence.claim);
      }
    } finally {active.delete(value);}
  }
  visit(meaning);
  return meaning;
}
