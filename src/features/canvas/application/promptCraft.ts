export const PROMPT_CRAFT_CATEGORIES = [
  { id: 'general', labelKey: 'promptCraft.category.general' },
  { id: 'photography', labelKey: 'promptCraft.category.photography' },
  { id: 'poster', labelKey: 'promptCraft.category.poster' },
  { id: 'product', labelKey: 'promptCraft.category.product' },
  { id: 'ui', labelKey: 'promptCraft.category.ui' },
  { id: 'character', labelKey: 'promptCraft.category.character' },
  { id: 'anime', labelKey: 'promptCraft.category.anime' },
  { id: 'gameAsset', labelKey: 'promptCraft.category.gameAsset' },
  { id: 'infographic', labelKey: 'promptCraft.category.infographic' },
  { id: 'illustration', labelKey: 'promptCraft.category.illustration' },
] as const;

export type PromptCraftCategoryId = (typeof PROMPT_CRAFT_CATEGORIES)[number]['id'];
