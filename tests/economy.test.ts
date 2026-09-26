import { describe, expect, it } from 'vitest';
import { closeMonth, formatYen, loanPayment, newEconomy, setTax, spend, takeLoan, type MonthInputs } from '../src/city/economy';
import { ageMix, eraOf, rankOf } from '../src/city/eras';

const inputs = (over: Partial<MonthInputs> = {}): MonthInputs => ({
  day: 30, residents: 1000, jobs: 400, buildingValue: 300_000, roadLength: { alley: 0, local: 3000, avenue: 0 },
  trade: 0, grant: 300, defense: 0, ...over,
});

describe('財政', () => {
  it('金額を億と万で表す', () => {
    expect(formatYen(0)).toBe('0万円');
    expect(formatYen(3400)).toBe('3,400万円');
    expect(formatYen(123_400)).toBe('12億3,400万円');
    expect(formatYen(200_000)).toBe('20億円');
    expect(formatYen(-5000)).toBe('−5,000万円');
  });
  it('月末に税収と維持費が資金に反映される', () => {
    const e = newEconomy();
    const before = e.money;
    const r = closeMonth(e, inputs());
    expect(r.income.res).toBeCloseTo(350);
    expect(r.income.biz).toBeCloseTo(200);
    expect(r.income.prop).toBeCloseTo(350);
    expect(r.expense.roads).toBeCloseTo(120);
    expect(e.money - before).toBeCloseTo(350 + 200 + 350 + 300 - 120);
  });
  it('税率を上げると税収が増える', () => {
    const a = newEconomy(), b = newEconomy();
    setTax(b, 'res', 12);
    expect(closeMonth(b, inputs()).income.res).toBeGreaterThan(closeMonth(a, inputs()).income.res);
    expect(setTax(b, 'res', 99)).toBe(15);
    expect(setTax(b, 'prop', 1.43)).toBe(1.4);
  });
  it('市債は元利均等で返し終わる', () => {
    const e = newEconomy();
    expect(typeof takeLoan(e, 10_000)).not.toBe('string');
    expect(loanPayment(12_000, 0, 120)).toBeCloseTo(100);
    for (let m = 0; m < 120; m++) closeMonth(e, inputs({ residents: 0, jobs: 0, buildingValue: 0, grant: 0, roadLength: { alley: 0, local: 0, avenue: 0 } }));
    expect(e.loans.length).toBe(0);
    expect(typeof takeLoan(e, 400_000)).toBe('string');
  });
  it('赤字が続くと財政再生団体になり、税を下げられなくなる', () => {
    const e = newEconomy();
    spend(e, e.money + 1000);
    for (let m = 0; m < 6; m++) closeMonth(e, inputs({ residents: 0, jobs: 0, buildingValue: 0, grant: 0 }));
    expect(e.bankrupt).toBe(true);
    expect(setTax(e, 'res', 5)).toBe(10);
  });
});

describe('時代', () => {
  it('年で時代と年齢構成が変わる', () => {
    expect(eraOf(1).name).toBe('再建期');
    expect(eraOf(45).name).toBe('繁栄期');
    expect(ageMix(70)[2]).toBeGreaterThan(ageMix(10)[2]);
    expect(rankOf(25_000)).toBe(1);
  });
});
