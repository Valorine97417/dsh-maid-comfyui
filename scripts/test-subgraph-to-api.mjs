/**
 * Offline self-test for scripts/subgraph-to-api.mjs — the subgraph flattener and
 * UI→API converter used when ComfyUI's own extractor refuses a canvas whose
 * body lives inside a subgraph.
 *
 * Fixtures are hand-written mini graphs mirroring the real shapes observed in
 * the Qwen Image 2.1 t2i / image_edit workflows, so this runs with no ComfyUI
 * and no object_info download.
 *
 *   node scripts/test-subgraph-to-api.mjs
 */
import assert from 'node:assert/strict'
import { convert, convertWorkflowFile, expandSubgraphs, zipWidgets } from './subgraph-to-api.mjs'

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`PASS: ${name}`)
}

// ---------------------------------------------------------------- object_info fixture

const objectInfo = {
  // widget 顺序 = required 全部 → optional 全部；seed 带 control_after_generate 占两格
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { control_after_generate: true }],
        steps: ['INT', {}],
        cfg: ['FLOAT', {}],
        sampler_name: [['euler', 'dpmpp_2m'], {}],
        scheduler: [['simple', 'normal'], {}],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', { default: 1 }],
      },
    },
    output: ['LATENT'],
  },
  EmptyLatentImage: {
    input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } },
    output: ['LATENT'],
  },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } }, output: ['IMAGE'] },
  VAELoader: { input: { required: { vae_name: [['v.safetensors'], {}] } }, output: ['VAE'] },
  UNETLoader: {
    input: { required: { unet_name: [['u.safetensors'], {}], weight_dtype: [['default'], {}] } },
    output: ['MODEL'],
  },
  SaveImageAdvanced: {
    input: {
      required: {
        images: ['IMAGE'],
        filename_prefix: ['STRING', { default: 'ComfyUI' }],
        format: ['COMFY_DYNAMICCOMBO_V3', {
          options: [
            { key: 'png', inputs: { required: { bit_depth: [['8-bit', '16-bit'], {}] } } },
            { key: 'exr', inputs: { required: { bit_depth: [['32-bit float'], {}] } } },
          ],
        }],
      },
    },
    output: [],
  },
  // 前端专属：required 含 IMAGECOMPARE 型输入 → 必须跳过
  ImageCompare: { input: { required: { compare_view: ['IMAGECOMPARE', {}] } }, output: [] },
  MarkdownNote: undefined, // 不在 object_info 里，靠 UI_ONLY 名单跳过
  // Autogrow：输入名带组前缀，且 min=0 允许整组留空
  TextEncode: {
    input: {
      required: {
        clip: ['CLIP'],
        prompt: ['STRING', {}],
        images: ['COMFY_AUTOGROW_V3', { template: { names: ['image_1', 'image_2'], min: 0 } }],
      },
    },
    output: ['CONDITIONING', 'CONDITIONING'],
  },
  CLIPLoader: { input: { required: { clip_name: [['c.safetensors'], {}], type: [['qwen_image'], {}] } }, output: ['CLIP'] },
  Cond: { input: { required: {} }, output: ['CONDITIONING'] },
  LazySwitch: {
    input: {
      required: { switch: ['BOOLEAN', {}] },
      optional: { on_false: ['COMFY_MATCHTYPE_V3', { lazy: true }], on_true: ['COMFY_MATCHTYPE_V3', { lazy: true }] },
    },
    output: ['*'],
  },
  ForceInputNode: {
    input: { required: { text: ['STRING', { forceInput: true }], mode: [['on', 'off'], {}] } },
    output: ['STRING'],
  },
}

// ---------------------------------------------------------------- zipWidgets

check('zipWidgets 跳过 control_after_generate 那一格', () => {
  // model / positive / negative / latent_image 是连线槽，不占 widget 格
  const out = zipWidgets('KSampler', objectInfo, [42, 'randomize', 25, 1, 'euler', 'simple', 1])
  assert.equal(out.seed, 42)
  assert.equal(out.steps, 25)
  assert.equal(out.cfg, 1)
  assert.equal(out.sampler_name, 'euler')
  assert.equal(out.scheduler, 'simple')
  assert.equal(out.denoise, 1)
})

check('zipWidgets 摊平 DynamicCombo 子项为 master.sub', () => {
  const out = zipWidgets('SaveImageAdvanced', objectInfo, ['Qwen_image_2.1', 'png', '8-bit'])
  assert.equal(out.filename_prefix, 'Qwen_image_2.1')
  assert.equal(out.format, 'png')
  assert.equal(out['format.bit_depth'], '8-bit')
})

check('zipWidgets 不消耗 forceInput 的 widget 格', () => {
  const out = zipWidgets('ForceInputNode', objectInfo, ['on'])
  assert.equal(out.mode, 'on')
  assert.equal(out.text, undefined)
})

// ---------------------------------------------------------------- expandSubgraphs

/** 子图 fixture：入参 prompt / steps / 出参 IMAGE，内部 UNETLoader→KSampler→VAEDecode。 */
const subgraphDef = {
  id: 'sub-uuid-1',
  name: 'Text to Image (fixture)',
  inputNode: { id: -10 },
  outputNode: { id: -20 },
  inputs: [
    { name: 'prompt', type: 'STRING' },
    { name: 'steps', type: 'INT' },
  ],
  outputs: [{ name: 'IMAGE', type: 'IMAGE' }],
  nodes: [
    { id: 1, type: 'UNETLoader', mode: 0, inputs: [], outputs: [{ name: 'MODEL', links: [100] }], widgets_values: ['u.safetensors', 'default'] },
    {
      id: 2, type: 'KSampler', mode: 0,
      inputs: [
        { name: 'model', type: 'MODEL', link: 100 },
        { name: 'seed', widget: { name: 'seed' }, link: null },
        { name: 'steps', type: 'INT', link: 101 },
        { name: 'cfg', widget: { name: 'cfg' }, link: null },
        { name: 'sampler_name', widget: { name: 'sampler_name' }, link: null },
        { name: 'scheduler', widget: { name: 'scheduler' }, link: null },
        { name: 'positive', type: 'CONDITIONING', link: null },
        { name: 'negative', type: 'CONDITIONING', link: null },
        { name: 'latent_image', type: 'LATENT', link: 102 },
        { name: 'denoise', widget: { name: 'denoise' }, link: null },
      ],
      outputs: [{ name: 'LATENT', links: [103] }],
      widgets_values: [7, 'randomize', 25, 1, 'euler', 'simple', 1],
    },
    { id: 3, type: 'EmptyLatentImage', mode: 0, inputs: [], outputs: [{ name: 'LATENT', links: [102] }], widgets_values: [1024, 1024, 1] },
    {
      id: 4, type: 'VAEDecode', mode: 0,
      inputs: [{ name: 'samples', type: 'LATENT', link: 103 }, { name: 'vae', type: 'VAE', link: 104 }],
      outputs: [{ name: 'IMAGE', links: [105] }],
    },
    { id: 5, type: 'VAELoader', mode: 0, inputs: [], outputs: [{ name: 'VAE', links: [104] }], widgets_values: ['v.safetensors'] },
    { id: 6, type: 'Cond', mode: 0, inputs: [], outputs: [{ name: 'CONDITIONING', links: [106, 107] }], widgets_values: [] },
  ],
  links: [
    { id: 100, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: 'MODEL' },
    { id: 101, origin_id: -10, origin_slot: 1, target_id: 2, target_slot: 2, type: 'INT' },
    { id: 102, origin_id: 3, origin_slot: 0, target_id: 2, target_slot: 8, type: 'LATENT' },
    { id: 103, origin_id: 2, origin_slot: 0, target_id: 4, target_slot: 0, type: 'LATENT' },
    { id: 104, origin_id: 5, origin_slot: 0, target_id: 4, target_slot: 1, type: 'VAE' },
    { id: 105, origin_id: 4, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' },
    { id: 106, origin_id: 6, origin_slot: 0, target_id: 2, target_slot: 6, type: 'CONDITIONING' },
    { id: 107, origin_id: 6, origin_slot: 0, target_id: 2, target_slot: 7, type: 'CONDITIONING' },
  ],
}

/** 外层图：子图实例 459 + 一个 SaveImageAdvanced + 一个前端专属节点。 */
function makeGraph() {
  return {
    id: 'fixture',
    nodes: [
      {
        id: 459, type: 'sub-uuid-1', mode: 0,
        inputs: [
          { name: 'prompt', label: 'prompt', type: 'STRING', link: null, widget: { name: 'prompt' } },
          { name: 'steps', label: 'steps', type: 'INT', link: null, widget: { name: 'steps' } },
        ],
        outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [672] }],
        // 关键：widget 型槽即便有连线也占一格 —— 这里没有连线，两格对应 prompt/steps
        widgets_values: ['a blue maid', 25],
      },
      {
        id: 461, type: 'SaveImageAdvanced', mode: 0,
        inputs: [
          { name: 'images', type: 'IMAGE', link: 672 },
          { name: 'filename_prefix', widget: { name: 'filename_prefix' }, link: null },
          { name: 'format', widget: { name: 'format' }, link: null },
        ],
        outputs: [],
        widgets_values: ['fixture_out', 'png', '8-bit'],
      },
      { id: 472, type: 'ImageCompare', mode: 0, inputs: [{ name: 'compare_view', link: null }], outputs: [] },
      { id: 463, type: 'MarkdownNote', mode: 0, inputs: [], outputs: [], widgets_values: ['note'] },
    ],
    links: [[672, 459, 0, 461, 0, 'IMAGE']],
    definitions: { subgraphs: [subgraphDef] },
  }
}

check('展开子图：实例被替换成内部节点，id 重编号', () => {
  const { graph, report } = expandSubgraphs(makeGraph())
  assert.equal(report.length, 1)
  assert.ok(!graph.nodes.some((n) => n.type === 'sub-uuid-1'), '实例节点应被移除')
  const types = graph.nodes.map((n) => n.type).sort()
  assert.deepEqual(types, ['Cond', 'EmptyLatentImage', 'ImageCompare', 'KSampler', 'MarkdownNote', 'SaveImageAdvanced', 'UNETLoader', 'VAEDecode', 'VAELoader'])
  assert.equal(graph.definitions.subgraphs, undefined, '子图定义应已清空')
})

check('展开子图：子图出参接到顶层消费者', () => {
  const { graph } = expandSubgraphs(makeGraph())
  const save = graph.nodes.find((n) => n.type === 'SaveImageAdvanced')
  const vaeDecode = graph.nodes.find((n) => n.type === 'VAEDecode')
  const l = graph.links.find((x) => x[3] === save.id && x[4] === 0)
  assert.ok(l !== undefined, 'SaveImageAdvanced 的 images 应有连线')
  assert.equal(l[1], vaeDecode.id, '连线应来自 VAEDecode')
})

check('展开子图：入参字面量写进目标节点 inputs[].literal', () => {
  const { graph } = expandSubgraphs(makeGraph())
  const ks = graph.nodes.find((n) => n.type === 'KSampler')
  const stepsEntry = ks.inputs.find((x) => x.name === 'steps')
  assert.equal(stepsEntry.literal, 25)
})

// ---------------------------------------------------------------- convert

check('转换：跳过前端专属节点、写对 widget 与连线', () => {
  const raw = makeGraph()
  const res = convertWorkflowFile(raw, objectInfo)
  assert.equal(res.ok, true, res.ok ? '' : res.error)
  const ids = Object.keys(res.workflow)
  const types = Object.values(res.workflow).map((n) => n.class_type)
  assert.ok(!types.includes('ImageCompare'), 'ImageCompare 应被跳过')
  assert.ok(!types.includes('MarkdownNote'), 'MarkdownNote 应被跳过')

  const ksId = ids.find((id) => res.workflow[id].class_type === 'KSampler')
  const ks = res.workflow[ksId]
  assert.equal(ks.inputs.steps, 25, '子图入参字面量应落到 KSampler.steps')
  assert.equal(ks.inputs.seed, 7)
  assert.equal(ks.inputs.cfg, 1)
  assert.equal(ks.inputs.sampler_name, 'euler')
  assert.equal(ks.inputs.denoise, 1)
  assert.deepEqual(ks.inputs.model, [ids.find((id) => res.workflow[id].class_type === 'UNETLoader'), 0])

  const saveId = ids.find((id) => res.workflow[id].class_type === 'SaveImageAdvanced')
  const save = res.workflow[saveId]
  assert.equal(save.inputs.filename_prefix, 'fixture_out')
  assert.equal(save.inputs['format.bit_depth'], '8-bit')
  assert.deepEqual(save.inputs.images, [ids.find((id) => res.workflow[id].class_type === 'VAEDecode'), 0])
})

check('转换：mode===4 的旁路节点被穿透', () => {
  const raw = makeGraph()
  const { graph } = expandSubgraphs(raw)
  const vaeDecode = graph.nodes.find((n) => n.type === 'VAEDecode')
  vaeDecode.mode = 4 // 停用，其输出应跟随第一个已连输入（samples ← KSampler）
  const res = convert(graph, objectInfo)
  assert.equal(res.ok, true, res.ok ? '' : res.error)
  const ids = Object.keys(res.workflow)
  const saveId = ids.find((id) => res.workflow[id].class_type === 'SaveImageAdvanced')
  const ksId = ids.find((id) => res.workflow[id].class_type === 'KSampler')
  assert.deepEqual(res.workflow[saveId].inputs.images, [ksId, 0], '旁路后应直连 KSampler')
})

check('转换：引用范围外节点时报错', () => {
  const raw = makeGraph()
  const { graph } = expandSubgraphs(raw)
  const save = graph.nodes.find((n) => n.type === 'SaveImageAdvanced')
  save.inputs[0].link = 99999 // 指向不存在的连线
  const res = convert(graph, objectInfo)
  // 连线解析不到 → 记 warning，inputs 里没有 images → 触发「缺少必需输入」
  assert.equal(res.ok, false)
  assert.match(res.error, /缺少必需输入/)
})

check('转换：Autogrow 组输入名保留前缀', () => {
  const graph = {
    nodes: [
      { id: 1, type: 'CLIPLoader', mode: 0, inputs: [], outputs: [{ name: 'CLIP', links: [1] }], widgets_values: ['c.safetensors', 'qwen_image'] },
      {
        id: 2, type: 'TextEncode', mode: 0,
        inputs: [
          { name: 'clip', type: 'CLIP', link: 1 },
          { name: 'prompt', widget: { name: 'prompt' }, link: null },
          { name: 'images.image_1', type: 'IMAGE', link: 2 },
        ],
        outputs: [{ name: 'CONDITIONING', links: [] }],
        widgets_values: ['hello'],
      },
      { id: 3, type: 'VAELoader', mode: 0, inputs: [], outputs: [{ name: 'VAE', links: [2] }], widgets_values: ['v.safetensors'] },
    ],
    links: [[1, 1, 0, 2, 0, 'CLIP'], [2, 3, 0, 2, 2, 'IMAGE']],
    definitions: {},
  }
  const res = convert(graph, objectInfo)
  assert.equal(res.ok, true, res.ok ? '' : res.error)
  const te = res.workflow['2']
  assert.equal(te.inputs.prompt, 'hello')
  assert.deepEqual(te.inputs['images.image_1'], ['3', 0], 'Autogrow 名必须带 images. 前缀')
})

check('转换：lazy 可选输入缺失不报错', () => {
  const graph = {
    nodes: [
      { id: 1, type: 'LazySwitch', mode: 0, inputs: [{ name: 'switch', widget: { name: 'switch' }, link: null }], outputs: [{ name: '*', links: [] }], widgets_values: [false] },
    ],
    links: [],
    definitions: {},
  }
  const res = convert(graph, objectInfo)
  assert.equal(res.ok, true, res.ok ? '' : res.error)
  assert.equal(res.workflow['1'].inputs.switch, false)
})

console.log(`\n${passed} passed`)
