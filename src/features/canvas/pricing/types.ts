export const PRICE_DISPLAY_CURRENCY_MODES = ['auto', 'cny', 'usd'] as const;
export type PriceDisplayCurrencyMode = (typeof PRICE_DISPLAY_CURRENCY_MODES)[number];

export const PRICE_CURRENCIES = ['CNY', 'USD'] as const;
export type PriceCurrency = (typeof PRICE_CURRENCIES)[number];

export interface GrsaiCreditTierDefinition {
  id: string;
  priceCny: number;
  credits: number;
}

/**
 * GRSAI 充值档（批次9 定价口径修正）：对齐 image-studio 技能实测口径「积分÷20000=元」
 * （1 点 = ¥0.00005，¥10 档 = 200000 点）。此前 credits 按 1 点=¥0.0001 标定，
 * 导致 nano-banana-2 报 ¥0.13（实际 ¥0.06）、pro 报 ¥0.18（实际 ¥0.09）。
 * 已选档位 id 语义不变（越贵的档每点越便宜），仅换算基准校正。
 */
export const GRSAI_CREDIT_TIERS = [
  { id: 'tier-10', priceCny: 10, credits: 200000 },
  { id: 'tier-20', priceCny: 20, credits: 500000 },
  { id: 'tier-49', priceCny: 49, credits: 1500000 },
  { id: 'tier-99', priceCny: 99, credits: 3200000 },
  { id: 'tier-499', priceCny: 499, credits: 18000000 },
  { id: 'tier-999', priceCny: 999, credits: 40000000 },
] as const satisfies readonly GrsaiCreditTierDefinition[];

export type GrsaiCreditTierId = (typeof GRSAI_CREDIT_TIERS)[number]['id'];

export const DEFAULT_GRSAI_CREDIT_TIER_ID: GrsaiCreditTierId = 'tier-10';

export interface PricingSettingsSnapshot {
  displayCurrencyMode: PriceDisplayCurrencyMode;
  usdToCnyRate: number;
  preferDiscountedPrice: boolean;
  grsaiCreditTierId: GrsaiCreditTierId;
}

export interface PriceComputationContext {
  resolution: string;
  extraParams?: Record<string, unknown>;
  settings: PricingSettingsSnapshot;
}

export interface ModelPriceQuote {
  amount: number;
  currency: PriceCurrency;
  originalAmount?: number;
  originalCurrency?: PriceCurrency;
  pointsCost?: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface ModelPricingDefinition {
  quote: (context: PriceComputationContext) => ModelPriceQuote | null;
}

