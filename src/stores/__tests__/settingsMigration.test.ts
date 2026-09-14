import { describe, expect, it } from 'vitest';

import { migratePersistedSettings } from '../settingsMigration';

describe('settingsMigration · v17 → v18', () => {
  it('老用户（v17 状态）补齐 v18 新字段默认值，lastUsedImageModel 原样保留', () => {
    const migrated = migratePersistedSettings({
      apiKeys: { grsai: 'sk-grsai-test' },
      lastUsedImageModel: '666api/gemini-3.1-flash-image-preview',
      usdToCnyRate: 7.2,
    });

    expect(migrated.imageGenMode).toBe('auto');
    expect(migrated.imageQuality).toBe('standard');
    expect(migrated.autoProbeOnLaunch).toBe(true);
    // 红线：不把老用户强行迁移到智能出图
    expect(migrated.lastUsedImageModel).toBe('666api/gemini-3.1-flash-image-preview');
  });

  it('尊重已持久化的 v18 字段值（不覆盖显式配置）', () => {
    const migrated = migratePersistedSettings({
      imageGenMode: 'expert',
      imageQuality: 'pro',
      autoProbeOnLaunch: false,
    });

    expect(migrated.imageGenMode).toBe('expert');
    expect(migrated.imageQuality).toBe('pro');
    expect(migrated.autoProbeOnLaunch).toBe(false);
  });

  it('非法值回退默认值', () => {
    const migrated = migratePersistedSettings({
      imageGenMode: 'whatever',
      imageQuality: 'ultra',
      autoProbeOnLaunch: undefined,
    });

    expect(migrated.imageGenMode).toBe('auto');
    expect(migrated.imageQuality).toBe('standard');
    expect(migrated.autoProbeOnLaunch).toBe(true);
  });

  it('空/损坏状态可安全迁移并给出全部默认值', () => {
    const migrated = migratePersistedSettings(null);

    expect(migrated.imageGenMode).toBe('auto');
    expect(migrated.imageQuality).toBe('standard');
    expect(migrated.autoProbeOnLaunch).toBe(true);
    expect(migrated.lastUsedImageModel).toBe('');
    expect(migrated.apiKeys).toEqual({});
    expect(migrated.backendSyncErrors).toEqual([]);
  });

  it('v19：backendSyncErrors 是运行时字段，rehydrate 时强制清空（陈旧失败项不可信）', () => {
    const migrated = migratePersistedSettings({ backendSyncErrors: ['juyouapi', 'ollama'] });
    expect(migrated.backendSyncErrors).toEqual([]);
  });

  it('v20：customEndpoints 老数据补 joinChain=false，显式 true 原样保留', () => {
    const migrated = migratePersistedSettings({
      customEndpoints: [
        { id: 'newapi_aaa1', name: '小胡API', baseUrl: 'https://x.example.com', selectedModels: ['gemini-3.1-flash-image-preview'] },
        { id: 'newapi_bbb2', name: '老王API', baseUrl: 'https://y.example.com', selectedModels: [], joinChain: true },
      ],
    });
    const endpoints = migrated.customEndpoints as Array<{ id: string; joinChain: boolean }>;
    expect(endpoints[0].joinChain).toBe(false);
    expect(endpoints[1].joinChain).toBe(true);
  });

  it('v21：aifastJoinChain 保留；v20 的 aifastModels 读取即丢弃（改静态清单）', () => {
    const migrated = migratePersistedSettings({ aifastJoinChain: true });
    expect(migrated.aifastJoinChain).toBe(true);
    // aifastModels 不在迁移输出中（字段退役，模型来自 models/image/aifast 静态清单）
    expect('aifastModels' in migrated).toBe(false);

    const migratedDefault = migratePersistedSettings({
      aifastModels: ['nano-banana-2', 'gemini-3-pro-image-preview'],
    });
    expect(migratedDefault.aifastJoinChain).toBe(false);
    expect('aifastModels' in migratedDefault).toBe(false);
  });

  it('回归：v17 既有迁移逻辑不被破坏（666api 单 key 分组 / juyouapi 合并）', () => {
    const migrated = migratePersistedSettings({
      apiKeys: { '666api': 'sk-666', juyouapi_default: 'sk-jy' },
    });
    const apiKeys = migrated.apiKeys as Record<string, string>;

    expect(apiKeys['666api']).toBeUndefined();
    expect(apiKeys['666api_default']).toBe('sk-666');
    expect(apiKeys['666api_gemini']).toBe('sk-666');
    expect(apiKeys['juyouapi']).toBe('sk-jy');
    expect(apiKeys['juyouapi_default']).toBeUndefined();
  });

  it('回归：空 apiKeys 分支（无 key 用户）同样补齐 v18 字段', () => {
    const migrated = migratePersistedSettings({ lastUsedImageModel: 'agnes/agnes-2.1-flash' });

    expect(migrated.imageGenMode).toBe('auto');
    expect(migrated.imageQuality).toBe('standard');
    expect(migrated.autoProbeOnLaunch).toBe(true);
    expect(migrated.lastUsedImageModel).toBe('agnes/agnes-2.1-flash');
  });

  it('v22：老用户（v21 状态）补齐 ossArchive 默认值（enabled=true，密钥为空）', () => {
    const migrated = migratePersistedSettings({
      aifastJoinChain: true,
      lastUsedImageModel: 'grsai/nano-banana-2',
    });
    expect(migrated.ossArchive).toEqual({ enabled: true, accessKey: '', secretKey: '' });
  });

  it('v22：已持久化的 ossArchive 原样保留（enabled=false 与密钥不被覆盖）', () => {
    const migrated = migratePersistedSettings({
      ossArchive: { enabled: false, accessKey: ' LTAIdummy-user-key ', secretKey: 'dummy-sk' },
    });
    expect(migrated.ossArchive).toEqual({
      enabled: false,
      accessKey: 'LTAIdummy-user-key',
      secretKey: 'dummy-sk',
    });
  });

  it('v22：ossArchive 形状非法时回落默认值（不崩、不透传垃圾）', () => {
    for (const bad of [null, 'str', 42, [], { enabled: 'yes' }]) {
      const migrated = migratePersistedSettings({ ossArchive: bad });
      expect(migrated.ossArchive).toEqual({ enabled: true, accessKey: '', secretKey: '' });
    }
  });
});

describe('settingsMigration · v23（AI 抠图服务地址）', () => {
  it('老用户缺失 aiMattingBaseUrl 时注入默认内网地址', () => {
    const migrated = migratePersistedSettings({
      imageGenMode: 'auto',
    });
    expect(migrated.aiMattingBaseUrl).toBe('http://192.168.1.188:8760');
  });

  it('空白字符串回落默认地址；自定义地址 trim 后保留', () => {
    const blank = migratePersistedSettings({ aiMattingBaseUrl: '   ' });
    expect(blank.aiMattingBaseUrl).toBe('http://192.168.1.188:8760');

    const custom = migratePersistedSettings({
      aiMattingBaseUrl: '  http://10.0.0.8:9000/  ',
    });
    expect(custom.aiMattingBaseUrl).toBe('http://10.0.0.8:9000');
  });

  it('非法类型（数字/对象）回落默认地址', () => {
    expect(migratePersistedSettings({ aiMattingBaseUrl: 42 }).aiMattingBaseUrl).toBe(
      'http://192.168.1.188:8760'
    );
    expect(
      migratePersistedSettings({ aiMattingBaseUrl: { url: 1 } }).aiMattingBaseUrl
    ).toBe('http://192.168.1.188:8760');
  });
});
