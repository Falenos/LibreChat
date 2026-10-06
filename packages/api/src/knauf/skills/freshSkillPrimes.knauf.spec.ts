import { Types } from 'mongoose';
import { collectKnaufFreshSkillPrimes, knaufPinnedSkillIds } from './freshSkillPrimes';

describe('[knauf] collectKnaufFreshSkillPrimes', () => {
  it('keeps one prime per name, manual before always-apply, with its id', () => {
    const manual = new Types.ObjectId();
    const always = new Types.ObjectId();
    const other = new Types.ObjectId();
    expect(
      collectKnaufFreshSkillPrimes({
        manualSkillPrimes: [{ name: 'karl-docx', _id: manual }],
        alwaysApplySkillPrimes: [
          { name: 'karl-docx', _id: always },
          { name: 'karl-brand', _id: other },
        ],
      }),
    ).toEqual([
      { name: 'karl-docx', _id: manual },
      { name: 'karl-brand', _id: other },
    ]);
  });

  it('returns nothing when no skill was primed', () => {
    expect(collectKnaufFreshSkillPrimes({})).toEqual([]);
  });
});

describe('[knauf] knaufPinnedSkillIds', () => {
  it('pins accessible primes and drops any the user cannot access', () => {
    const allowed = new Types.ObjectId();
    const denied = new Types.ObjectId();
    const pinned = knaufPinnedSkillIds(
      [
        { name: 'karl-docx', _id: allowed },
        { name: 'karl-pptx', _id: denied },
      ],
      [new Types.ObjectId(allowed.toHexString())],
    );
    expect([...pinned.keys()]).toEqual(['karl-docx']);
    expect(String(pinned.get('karl-docx'))).toBe(String(allowed));
  });

  it('keeps the first id for a repeated name', () => {
    const first = new Types.ObjectId();
    const second = new Types.ObjectId();
    const pinned = knaufPinnedSkillIds(
      [
        { name: 'karl-docx', _id: first },
        { name: 'karl-docx', _id: second },
      ],
      [first, second],
    );
    expect(String(pinned.get('karl-docx'))).toBe(String(first));
  });
});
