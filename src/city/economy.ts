import { curveLength } from './geometry';
import type { RoadPlan, RoadType } from './roads';

/**
 * お金の単位は「万円」。
 * 税率は％（固定資産税の標準税率 1.4％ など、日本の制度に合わせた値を既定にする）。
 */
export const ROAD_COST: Record<RoadType, number> = { alley: 4, local: 9, avenue: 22 };
export const ROAD_UPKEEP: Record<RoadType, number> = { alley: 0.02, local: 0.04, avenue: 0.1 };
export const BRIDGE_FACTOR = 5;
export const ROAD_REFUND = 0.5;
export const START_MONEY = 200_000;

export interface Taxes {
  /** 住民税 */
  res: number;
  /** 法人の税（法人住民税と事業税をまとめたもの） */
  biz: number;
  /** 固定資産税 */
  prop: number;
}
export type TaxKey = keyof Taxes;
export const DEFAULT_TAXES: Taxes = { res: 10, biz: 10, prop: 1.4 };
export const TAX_LIMITS: Record<TaxKey, [number, number, number]> = {
  res: [5, 15, 0.5],
  biz: [5, 15, 0.5],
  prop: [0.8, 2.1, 0.1],
};
export const TAX_NAMES: Record<TaxKey, string> = { res: '住民税', biz: '法人の税', prop: '固定資産税' };

export interface Loan {
  id: number;
  principal: number;
  remaining: number;
  monthly: number;
  monthsLeft: number;
  /** 年利（％） */
  rate: number;
}
export const LOAN_OPTIONS = [10_000, 50_000, 100_000];
export const LOAN_RATE = 1.2;
export const LOAN_MONTHS = 120;
export const MAX_DEBT = 300_000;

export type IncomeKey = 'res' | 'biz' | 'prop' | 'trade' | 'grant' | 'other';
export type ExpenseKey = 'roads' | 'services' | 'imports' | 'policies' | 'loans' | 'construction' | 'defense' | 'other';
export const INCOME_NAMES: Record<IncomeKey, string> = {
  res: '住民税', biz: '法人の税', prop: '固定資産税', trade: '交易', grant: '国からの交付金', other: 'その他',
};
export const EXPENSE_NAMES: Record<ExpenseKey, string> = {
  roads: '道路の維持費', services: '施設の維持費', imports: '電気・水などの購入', policies: '政策', loans: '市債の返済',
  construction: '建設費', defense: '防衛費', other: '災害復旧など',
};

export interface MonthReport {
  day: number;
  income: Record<IncomeKey, number>;
  expense: Record<ExpenseKey, number>;
  net: number;
  money: number;
}

export interface EconomyState {
  money: number;
  taxes: Taxes;
  loans: Loan[];
  reports: MonthReport[];
  /** 今月のうちに使った・入ったお金（月末の報告にまとめる） */
  pending: { construction: number; other: number; refund: number };
  deficitMonths: number;
  surplusMonths: number;
  /** 財政再生団体 */
  bankrupt: boolean;
  nextLoanId: number;
}

export function newEconomy(): EconomyState {
  return {
    money: START_MONEY, taxes: { ...DEFAULT_TAXES }, loans: [], reports: [],
    pending: { construction: 0, other: 0, refund: 0 },
    deficitMonths: 0, surplusMonths: 0, bankrupt: false, nextLoanId: 1,
  };
}

/** 道路の建設費 */
export function planCost(plan: RoadPlan): number {
  let cost = 0;
  for (const pc of plan.pieces) {
    const len = curveLength(pc.curve);
    const bridgeShare = pc.bridge.filter(Boolean).length / Math.max(1, pc.bridge.length);
    cost += len * ROAD_COST[plan.type] * (1 + (BRIDGE_FACTOR - 1) * bridgeShare);
  }
  return Math.round(cost);
}

/** 元利均等返済の月々の額 */
export function loanPayment(principal: number, annualRate: number, months: number): number {
  const r = annualRate / 100 / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

export function totalDebt(e: EconomyState): number {
  return e.loans.reduce((s, l) => s + l.remaining, 0);
}

/** 市債を発行する。できなければ理由を返す */
export function takeLoan(e: EconomyState, amount: number): Loan | string {
  if (totalDebt(e) + amount > MAX_DEBT) return `市債の残高は ${formatYen(MAX_DEBT)} までです`;
  const loan: Loan = {
    id: e.nextLoanId++, principal: amount, remaining: amount,
    monthly: loanPayment(amount, LOAN_RATE, LOAN_MONTHS), monthsLeft: LOAN_MONTHS, rate: LOAN_RATE,
  };
  e.loans.push(loan);
  e.money += amount;
  return loan;
}

export function spend(e: EconomyState, amount: number, kind: 'construction' | 'other' = 'construction'): void {
  e.money -= amount;
  e.pending[kind] += amount;
}

export function refund(e: EconomyState, amount: number): void {
  e.money += amount;
  e.pending.refund += amount;
}

export interface MonthInputs {
  day: number;
  residents: number;
  /** 市内で働く人の数（法人の税の対象） */
  jobs: number;
  buildingValue: number;
  roadLength: Record<RoadType, number>;
  trade: number;
  grant: number;
  defense: number;
  services?: number;
  imports?: number;
  policies?: number;
}

/** 月末の締め。収支を計算して資金に反映し、報告を返す */
export function closeMonth(e: EconomyState, m: MonthInputs): MonthReport {
  const t = e.taxes;
  const income: Record<IncomeKey, number> = {
    res: m.residents * 0.35 * (t.res / 10),
    biz: m.jobs * 0.5 * (t.biz / 10),
    prop: (m.buildingValue * t.prop) / 100 / 12,
    trade: m.trade,
    grant: m.grant,
    other: e.pending.refund,
  };
  let loanPay = 0;
  for (const l of e.loans) {
    const interest = (l.remaining * l.rate) / 100 / 12;
    const pay = Math.min(l.monthly, l.remaining + interest);
    l.remaining = Math.max(0, l.remaining + interest - pay);
    l.monthsLeft--;
    loanPay += pay;
  }
  e.loans = e.loans.filter((l) => l.remaining > 0.5 && l.monthsLeft > 0);
  let roads = 0;
  for (const k of Object.keys(m.roadLength) as RoadType[]) roads += m.roadLength[k] * ROAD_UPKEEP[k];
  const services = m.services ?? 0, imports = m.imports ?? 0, policies = m.policies ?? 0;
  const expense: Record<ExpenseKey, number> = {
    roads, services, imports, policies, loans: loanPay, construction: e.pending.construction, defense: m.defense, other: e.pending.other,
  };
  // 建設費・払い戻しはその場で資金に反映済みなので、ここでは定常の収支だけ動かす
  const recurring = income.res + income.biz + income.prop + income.trade + income.grant - roads - services - imports - policies - loanPay - m.defense;
  e.money += recurring;
  const net = Object.values(income).reduce((a, b) => a + b, 0) - Object.values(expense).reduce((a, b) => a + b, 0);
  const report: MonthReport = { day: m.day, income, expense, net, money: e.money };
  e.reports.push(report);
  if (e.reports.length > 24) e.reports.shift();
  e.pending = { construction: 0, other: 0, refund: 0 };

  // 財政再生団体：赤字が半年続くか、大きな赤字になったら転落。黒字が 3 か月続けば脱出
  if (e.money < 0) { e.deficitMonths++; e.surplusMonths = 0; } else { e.surplusMonths++; e.deficitMonths = 0; }
  if (!e.bankrupt && (e.deficitMonths >= 6 || e.money < -50_000)) e.bankrupt = true;
  else if (e.bankrupt && e.surplusMonths >= 3) e.bankrupt = false;
  if (e.bankrupt) {
    // 再生計画のもとでは、税率を標準より下げられない
    for (const k of Object.keys(DEFAULT_TAXES) as TaxKey[]) e.taxes[k] = Math.max(e.taxes[k], DEFAULT_TAXES[k]);
  }
  return report;
}

/** 税率を変える（範囲と刻みに合わせる） */
export function setTax(e: EconomyState, key: TaxKey, value: number): number {
  const [lo, hi, step] = TAX_LIMITS[key];
  let v = Math.round(value / step) * step;
  if (e.bankrupt) v = Math.max(v, DEFAULT_TAXES[key]);
  e.taxes[key] = Math.round(Math.min(hi, Math.max(lo, v)) * 10) / 10;
  return e.taxes[key];
}

/** 「12億3,400万円」のような表記 */
export function formatYen(man: number): string {
  const neg = man < 0;
  const v = Math.round(Math.abs(man));
  const oku = Math.floor(v / 10000), rest = v % 10000;
  let s: string;
  if (oku && rest) s = `${oku.toLocaleString()}億${rest.toLocaleString()}万円`;
  else if (oku) s = `${oku.toLocaleString()}億円`;
  else s = `${rest.toLocaleString()}万円`;
  return (neg ? '−' : '') + s;
}
