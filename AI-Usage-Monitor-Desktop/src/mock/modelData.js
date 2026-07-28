export const modelList = [
  // ============ Plan 订阅模式 ============
  {
    id: 'ds-v3',
    name: 'DeepSeek-V3',
    type: '大语言模型',
    provider: 'DeepSeek API',
    billingModel: 'plan',
    createdTime: '2025-06-15',
    status: 'running',
    description: 'DeepSeek 最新版大语言模型，支持多轮对话与复杂推理，具备优秀的代码生成与数学推理能力。',
    allowance: {
      planName: 'Pro 月费订阅',
      planTokensTotal: 5000000,
      planTokensUsed: 3850000,
      planCost: '¥79.00 / 月',
      nextRenewal: '2026-08-15',
      remainingTokens: 1150000,
      usedPercent: 77
    },
    config: {
      modelId: 'deepseek-v3-chat',
      maxTokens: 8192,
      contextLength: 128000,
      pricing: '¥1.00 / 1M tokens (输入) · ¥2.00 / 1M tokens (输出)'
    },
    usageHistory: [
      { date: '2026-07-21', requests: 1258, tokens: 450000, cost: 0.68 },
      { date: '2026-07-22', requests: 1420, tokens: 510000, cost: 0.77 },
      { date: '2026-07-23', requests: 1103, tokens: 420000, cost: 0.63 },
      { date: '2026-07-24', requests: 1685, tokens: 580000, cost: 0.87 },
      { date: '2026-07-25', requests: 1520, tokens: 530000, cost: 0.80 },
      { date: '2026-07-26', requests: 1350, tokens: 480000, cost: 0.72 },
      { date: '2026-07-27', requests: 980, tokens: 360000, cost: 0.54 }
    ],
    performance: {
      avgLatency: '1.2s',
      p95Latency: '2.8s',
      successRate: '99.87%',
      avgTokensPerRequest: 2650,
      totalRequests: 9316,
      totalTokens: '24.88M'
    },
    notes: [
      '适用场景：对话系统、代码生成、内容创作、数据分析',
      '剩余额度不足 20% 时自动触发告警通知',
      '超额后可临时购买附加包或等待下月重置',
      '建议设置月度预算上限防超支'
    ]
  },
  {
    id: 'kimi-moonshot',
    name: 'Kimi (Moonshot)',
    type: '大语言模型',
    provider: 'Kimi API',
    billingModel: 'plan',
    createdTime: '2025-07-20',
    status: 'running',
    description: 'Moonshot 推出的长文本大语言模型，以超长上下文处理能力著称，适合文档分析、科研论文阅读等场景。',
    allowance: {
      planName: '入门月费订阅',
      planTokensTotal: 1200000,
      planTokensUsed: 780000,
      planCost: '¥35.00 / 月',
      nextRenewal: '2026-08-20',
      remainingTokens: 420000,
      usedPercent: 65
    },
    config: {
      modelId: 'moonshot-v1-8k',
      maxTokens: 4096,
      contextLength: 128000,
      pricing: '¥0.60 / 1M tokens (输入) · ¥2.00 / 1M tokens (输出)'
    },
    usageHistory: [
      { date: '2026-07-21', requests: 680, tokens: 140000, cost: 0.21 },
      { date: '2026-07-22', requests: 750, tokens: 152000, cost: 0.23 },
      { date: '2026-07-23', requests: 620, tokens: 128000, cost: 0.19 },
      { date: '2026-07-24', requests: 890, tokens: 175000, cost: 0.26 },
      { date: '2026-07-25', requests: 810, tokens: 160000, cost: 0.24 },
      { date: '2026-07-26', requests: 720, tokens: 145000, cost: 0.22 },
      { date: '2026-07-27', requests: 540, tokens: 110000, cost: 0.17 }
    ],
    performance: {
      avgLatency: '1.8s',
      p95Latency: '3.5s',
      successRate: '99.62%',
      avgTokensPerRequest: 7200,
      totalRequests: 5010,
      totalTokens: '37.00M'
    },
    notes: [
      '适用场景：长文档分析、论文阅读、合同审查、知识问答',
      '超长上下文（128K）是核心优势，适合处理大量文本输入',
      '超额后自动按量计费：¥0.60/1M tokens (输入) ＋ ¥2.00/1M tokens (输出)',
      '建议搭配文件上传功能发挥长文本优势'
    ]
  },
  {
    id: 'gpt4o',
    name: 'GPT-4o',
    type: '大语言模型',
    provider: 'OpenAI API',
    billingModel: 'plan',
    createdTime: '2025-05-10',
    status: 'running',
    description: 'OpenAI 多模态大语言模型，支持文本、图像、音频输入，在理解、推理、编码方面表现卓越。',
    allowance: {
      planName: 'Team 季费订阅',
      planTokensTotal: 8000000,
      planTokensUsed: 5200000,
      planCost: '$199.00 / 季度',
      nextRenewal: '2026-09-10',
      remainingTokens: 2800000,
      usedPercent: 65
    },
    config: {
      modelId: 'gpt-4o-2024-08-06',
      maxTokens: 16384,
      contextLength: 128000,
      pricing: '$2.50 / 1M tokens (输入) · $10.00 / 1M tokens (输出)'
    },
    usageHistory: [
      { date: '2026-07-21', requests: 520, tokens: 390000, cost: 2.65 },
      { date: '2026-07-22', requests: 600, tokens: 440000, cost: 2.97 },
      { date: '2026-07-23', requests: 480, tokens: 350000, cost: 2.41 },
      { date: '2026-07-24', requests: 720, tokens: 510000, cost: 3.50 },
      { date: '2026-07-25', requests: 650, tokens: 470000, cost: 3.18 },
      { date: '2026-07-26', requests: 580, tokens: 410000, cost: 2.80 },
      { date: '2026-07-27', requests: 420, tokens: 300000, cost: 2.03 }
    ],
    performance: {
      avgLatency: '0.8s',
      p95Latency: '2.0s',
      successRate: '99.93%',
      avgTokensPerRequest: 5000,
      totalRequests: 3970,
      totalTokens: '20.30M'
    },
    notes: [
      '适用场景：多模态理解、复杂推理、代码开发、数据分析',
      '支持图像输入，可进行图片内容分析和文档 OCR',
      '余额耗尽后自动暂停，需手动续费或购买附加包',
      '建议使用缓存机制减少重复请求，降低 Token 消耗'
    ]
  },
  // ============ Token 按量计费模式 ============
  {
    id: 'qwen-max',
    name: 'Qwen-Max',
    type: '大语言模型',
    provider: 'Aliyun API',
    billingModel: 'token',
    createdTime: '2025-08-01',
    status: 'running',
    description: '阿里云通义千问最大参数规模模型，在中文理解、数学推理、代码生成等任务上表现优异。',
    allowance: {
      totalBudget: 500.00,
      spent: 312.50,
      remaining: 187.50,
      currency: '¥',
      usedPercent: 63,
      billingCycle: '按月账单结算',
      nextBillingDate: '2026-08-01'
    },
    config: {
      modelId: 'qwen-max-0919',
      maxTokens: 8192,
      contextLength: 32000,
      pricing: '¥2.00 / 1M tokens (输入) · ¥6.00 / 1M tokens (输出)'
    },
    usageHistory: [
      { date: '2026-07-21', requests: 380, tokens: 320000, cost: 1.04 },
      { date: '2026-07-22', requests: 420, tokens: 360000, cost: 1.15 },
      { date: '2026-07-23', requests: 350, tokens: 290000, cost: 0.94 },
      { date: '2026-07-24', requests: 500, tokens: 410000, cost: 1.33 },
      { date: '2026-07-25', requests: 450, tokens: 380000, cost: 1.21 },
      { date: '2026-07-26', requests: 400, tokens: 340000, cost: 1.09 },
      { date: '2026-07-27', requests: 310, tokens: 260000, cost: 0.83 }
    ],
    performance: {
      avgLatency: '1.0s',
      p95Latency: '2.2s',
      successRate: '99.78%',
      avgTokensPerRequest: 4900,
      totalRequests: 2810,
      totalTokens: '13.75M'
    },
    notes: [
      '适用场景：中文内容生成、电商文案、客服对话、知识库问答',
      '按量计费，月底统一出账，无预付额度限制',
      '超额时会自动从绑定的支付宝/银行卡扣款',
      '建议设置月度费用上限（硬性预算上限）防止意外超标'
    ]
  },
  {
    id: 'glm-4',
    name: 'GLM-4',
    type: '大语言模型',
    provider: '智谱 AI',
    billingModel: 'token',
    createdTime: '2025-09-12',
    status: 'stopped',
    description: '智谱 AI 第四代双语大语言模型，具备强大的中文理解与生成能力，支持工具调用。',
    allowance: {
      totalBudget: 200.00,
      spent: 198.50,
      remaining: 1.50,
      currency: '¥',
      usedPercent: 99,
      billingCycle: '按月账单结算',
      nextBillingDate: '2026-08-01'
    },
    config: {
      modelId: 'glm-4-plus',
      maxTokens: 4096,
      contextLength: 128000,
      pricing: '¥0.50 / 1M tokens (输入) · ¥2.00 / 1M tokens (输出)'
    },
    usageHistory: [
      { date: '2026-07-21', requests: 200, tokens: 180000, cost: 0.36 },
      { date: '2026-07-22', requests: 180, tokens: 160000, cost: 0.32 },
      { date: '2026-07-23', requests: 150, tokens: 130000, cost: 0.28 },
      { date: '2026-07-24', requests: 220, tokens: 190000, cost: 0.40 },
      { date: '2026-07-25', requests: 190, tokens: 170000, cost: 0.34 },
      { date: '2026-07-26', requests: 160, tokens: 140000, cost: 0.30 },
      { date: '2026-07-27', requests: 0, tokens: 0, cost: 0 }
    ],
    performance: {
      avgLatency: '1.5s',
      p95Latency: '3.0s',
      successRate: '99.45%',
      avgTokensPerRequest: 5000,
      totalRequests: 1100,
      totalTokens: '5.50M'
    },
    notes: [
      '适用场景：中文对话、内容生成、翻译、摘要提取',
      '当月预算已接近耗尽（99%），已自动暂停服务',
      '支持工具调用（Function Calling），可接入外部系统',
      '如需恢复使用，请前往智谱 AI 控制台提升预算上限'
    ]
  },
  {
    id: 'sd-xl',
    name: 'Stable Diffusion XL',
    type: '图像生成模型',
    provider: 'Stability AI',
    billingModel: 'token',
    createdTime: '2025-10-05',
    status: 'running',
    description: 'Stability AI 推出的高分辨率文本到图像生成模型，支持多种风格和精细控制。',
    allowance: {
      totalBudget: 1000.00,
      spent: 558.25,
      remaining: 441.75,
      currency: '¥',
      usedPercent: 56,
      billingCycle: '按月账单结算',
      nextBillingDate: '2026-08-01'
    },
    config: {
      modelId: 'stable-diffusion-xl-base-1.0',
      maxTokens: 77,
      contextLength: 'N/A',
      pricing: '¥0.08 / 张 (512×512) · ¥0.16 / 张 (1024×1024)'
    },
    usageHistory: [
      { date: '2026-07-21', requests: 350, tokens: 0, cost: 42.00 },
      { date: '2026-07-22', requests: 380, tokens: 0, cost: 45.60 },
      { date: '2026-07-23', requests: 310, tokens: 0, cost: 37.20 },
      { date: '2026-07-24', requests: 420, tokens: 0, cost: 50.40 },
      { date: '2026-07-25', requests: 390, tokens: 0, cost: 46.80 },
      { date: '2026-07-26', requests: 340, tokens: 0, cost: 40.80 },
      { date: '2026-07-27', requests: 280, tokens: 0, cost: 33.60 }
    ],
    performance: {
      avgLatency: '8.5s',
      p95Latency: '15.0s',
      successRate: '98.50%',
      avgTokensPerRequest: 0,
      totalRequests: 2470,
      totalTokens: 'N/A'
    },
    notes: [
      '适用场景：概念设计、广告素材、游戏原画、艺术创作',
      '按图片数量计费，非 Token 模型，无上下文消耗',
      '当前月预算利用率 56%，处于健康区间',
      '建议使用负面提示词（Negative Prompt）提升生成质量'
    ]
  }
]

export const MODEL_COLORS = {
  'DeepSeek-V3': '#3b82f6',
  'Kimi (Moonshot)': '#10b981',
  'GPT-4o': '#f59e0b',
  'Qwen-Max': '#8b5cf6',
  'GLM-4': '#ef4444',
  'Stable Diffusion XL': '#ec4899'
}