/**
 * 子图展开 + 画布图（UI 格式）→ API 工作流（自研，不依赖 lib/convert.ts）。
 *
 * 为什么需要它：ComfyUI 前端保存的图工作流常把主体封进「子图」（subgraph），
 * 顶层只剩一个 type 等于子图 UUID 的实例节点。插件的 analyzeGraph / convert.ts
 * 把子图当黑盒，会报「包含未注册的 UI-only 节点 "<uuid>"」，提取不了。
 * 本脚本先把子图内联摊平，再按 object_info 契约转成可 POST /prompt 的 API 格式。
 *
 * 关键约定（已在本机 Qwen Image 2.1 的 t2i / image_edit 上实测验证）：
 * 1. 子图实例节点的 widgets_values 顺序 == 子图 definitions.inputs 的槽位顺序，
 *    其中只有 widget 型槽（STRING/INT/FLOAT/BOOLEAN/COMBO）占一格——
 *    **即便该槽在实例上有外部连线，也照样占一格**（数错就整条错位）。
 *    子图内部连线里 origin_id === -10 指向入参槽（origin_slot 即槽下标），
 *    target_id === -20 指向出参槽。
 * 2. 节点 widgets_values 顺序 == object_info 的 required 全部 → optional 全部，
 *    只算 widget 型；DynamicCombo 的 master 占一格、其子项按所选 key 的
 *    inputs.required→optional 顺序紧随其后（输入名是 `master.sub`）；
 *    INT 且 control_after_generate===true 时其后多一格下拉值（消费后丢弃）；
 *    forceInput===true 的 widget 不占槽。
 * 3. Autogrow 组（COMFY_AUTOGROW_V3）的输入名要**保留组前缀**（`images.image0`），
 *    剥掉前缀会让 ComfyUI /prompt 返回 400 required_input_missing。
 * 4. 只存在于画布上的前端节点（MarkdownNote / ImageCompare 等）要跳过，
 *    判据是 object_info 里该节点的 required 输入含前端专属类型。
 *
 * 用法:
 *   node scripts/subgraph-to-api.mjs <workflow.json> [out.json] [选项]
 * 选项:
 *   --base-url <url>       ComfyUI 地址（默认 http://127.0.0.1:8188），用它实时拉 object_info
 *   --object-info <file>   改用本地 object_info 转储（离线 / 不连 ComfyUI 时用）
 *   --quiet                不打印转换后的工作流 JSON
 *
 * 转换完想直接跑，可 POST 到 ComfyUI：
 *   curl -X POST http://127.0.0.1:8188/prompt \
 *     -H 'Content-Type: application/json' \
 *     --data-binary @- <<'JSON'
 *   {"prompt": <out.json 的内容>, "client_id": "manual"}
 *   JSON
 * 再轮询 GET /history/<prompt_id> 取输出文件名。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const UI_ONLY = new Set(['Note', 'StickyNote', 'Reroute', 'Fast Groups Bypasser (rgthree)', 'MarkdownNote', 'ImageCompare'])
// 前端专属输入类型：这些 widget 只在画布上存在，API 侧没有对应输入
const UI_INPUT_TYPES = new Set(['IMAGECOMPARE', 'RESOLUTION_PREVIEW', 'IMAGEUPLOAD'])
const WIDGET_TYPES = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO'])

function isUiOnlyNode(type, objectInfo) {
  if (UI_ONLY.has(type)) return true
  const req = objectInfo[type]?.input?.required ?? {}
  return Object.values(req).some((spec) => Array.isArray(spec) && UI_INPUT_TYPES.has(spec[0]))
}

function toObjectLink(l) {
  if (!Array.isArray(l)) return l
  return { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] }
}

/**
 * Autogrow 输入名保持原样：实测 ComfyUI 校验器要的就是带组前缀的全名
 * （报错 extra_info.input_name = "images.image0"），剥前缀会报 required_input_missing。
 */
function normalizeInputName(name) {
  return name
}

/** 按 object_info 的 schema 顺序把 widgets_values 摊成 { inputName: value }。 */
export function zipWidgets(classType, objectInfo, values) {
  const out = {}
  const vals = Array.isArray(values) ? values : []
  let i = 0
  const take = () => (i < vals.length ? vals[i++] : undefined)
  const walk = (fields, prefix) => {
    for (const [key, spec] of Object.entries(fields ?? {})) {
      if (!Array.isArray(spec)) continue
      const [typeSpec, options] = spec
      const full = prefix ? `${prefix}.${key}` : key
      if (Array.isArray(typeSpec)) { out[full] = take(); continue }
      if (typeSpec === 'COMBO') { if (options?.forceInput !== true) out[full] = take(); continue }
      if (typeSpec === 'INT' || typeSpec === 'FLOAT' || typeSpec === 'STRING' || typeSpec === 'BOOLEAN') {
        if (options?.forceInput === true) continue
        out[full] = take()
        if (typeSpec === 'INT' && options?.control_after_generate === true && prefix === '') i++
        continue
      }
      if (typeSpec === 'COMFY_DYNAMICCOMBO_V3') {
        const chosen = take()
        out[full] = chosen
        const opt = (options?.options ?? []).find((o) => o.key === chosen)
        if (opt !== undefined) {
          walk(opt.inputs?.required ?? {}, full)
          walk(opt.inputs?.optional ?? {}, full)
        }
        continue
      }
      // 其余（MODEL/CLIP/IMAGE/COMFY_AUTOGROW_V3/...）不占 widget 槽
    }
  }
  walk(objectInfo[classType]?.input?.required, '')
  walk(objectInfo[classType]?.input?.optional, '')
  return out
}

/** 子图实例内联展开成扁平图。返回 { graph, report }。 */
export function expandSubgraphs(graph) {
  const defs = new Map((graph.definitions?.subgraphs ?? []).map((s) => [s.id, s]))
  const outNodes = []
  const pending = []
  const report = []

  let nextId = 1
  for (const n of graph.nodes) nextId = Math.max(nextId, Number(n.id) + 1)
  nextId += 100000 // 让展开出来的 id 与顶层 id 明显区分，便于排查

  const topLinks = (graph.links ?? []).map(toObjectLink)
  const topLinkById = new Map(topLinks.map((l) => [l.id, l]))

  for (const n of graph.nodes) {
    if (!defs.has(n.type)) {
      outNodes.push({
        ...n,
        inputs: (n.inputs ?? []).map((x) => ({ ...x })),
        outputs: (n.outputs ?? []).map((o) => ({ ...o, links: [...(o.links ?? [])] })),
      })
      continue
    }
    const sg = defs.get(n.type)
    report.push(`展开子图实例 ${n.id} → ${sg.name}（${sg.nodes.length} 内部节点）`)

    const idMap = new Map()
    for (const sn of sg.nodes) {
      const nid = nextId++
      idMap.set(Number(sn.id), nid)
      outNodes.push({
        ...sn,
        id: nid,
        inputs: (sn.inputs ?? []).map((x) => ({ ...x })),
        outputs: (sn.outputs ?? []).map((o) => ({ ...o, links: [] })),
      })
    }

    // 定义槽 → 外部来源：优先实例连线，其次按槽位顺序取实例 widgets_values
    // （实测：widget 型槽一律占一格，即便该槽在实例上有连线）
    const slotSource = new Map()
    let wi = 0
    for (let s = 0; s < sg.inputs.length; s++) {
      const slot = sg.inputs[s]
      const isWidget = WIDGET_TYPES.has(slot.type)
      const value = isWidget ? (n.widgets_values ?? [])[wi] : undefined
      if (isWidget) wi++
      const inst = (n.inputs ?? []).find((x) => x.name === slot.name)
      if (inst && inst.link !== null && inst.link !== undefined) {
        const tl = topLinkById.get(inst.link)
        slotSource.set(s, tl ? { kind: 'ext', origin_id: tl.origin_id, origin_slot: tl.origin_slot } : { kind: 'none' })
      } else if (isWidget) {
        slotSource.set(s, { kind: 'value', value })
      } else {
        slotSource.set(s, { kind: 'none' })
      }
    }

    for (const l of sg.links ?? []) {
      if (l.target_id === -20) continue
      const tgt = idMap.get(Number(l.target_id))
      if (tgt === undefined) continue
      if (l.origin_id === -10) {
        const src = slotSource.get(l.origin_slot)
        if (!src || src.kind === 'none') continue
        if (src.kind === 'value') {
          pending.push({ literal: true, target_id: tgt, target_slot: l.target_slot, value: src.value })
          continue
        }
        pending.push({ origin_id: src.origin_id, origin_slot: src.origin_slot, target_id: tgt, target_slot: l.target_slot })
        continue
      }
      const org = idMap.get(Number(l.origin_id))
      if (org === undefined) continue
      pending.push({ origin_id: org, origin_slot: l.origin_slot, target_id: tgt, target_slot: l.target_slot })
    }

    // 子图输出 → 顶层消费者
    for (const l of topLinks) {
      if (Number(l.origin_id) !== Number(n.id)) continue
      const sgOut = (sg.links ?? []).find((x) => x.target_id === -20 && x.target_slot === l.origin_slot)
      if (sgOut === undefined) continue
      const org = idMap.get(Number(sgOut.origin_id))
      if (org === undefined) continue
      pending.push({ origin_id: org, origin_slot: sgOut.origin_slot, target_id: l.target_id, target_slot: l.target_slot })
    }
  }

  // 顶层非子图出处的连线
  for (const l of topLinks) {
    const srcTop = graph.nodes.find((x) => Number(x.id) === Number(l.origin_id))
    if (srcTop && defs.has(srcTop.type)) continue
    pending.push({ origin_id: l.origin_id, origin_slot: l.origin_slot, target_id: l.target_id, target_slot: l.target_slot })
  }

  // 重编号并写回 inputs[].link / outputs[].links
  const byId = new Map(outNodes.map((x) => [x.id, x]))
  const links = []
  let lid = 1
  for (const p of pending) {
    const id = lid++
    if (p.literal) {
      const dst = byId.get(Number(p.target_id))
      if (dst?.inputs?.[p.target_slot]) {
        dst.inputs[p.target_slot].link = null
        dst.inputs[p.target_slot].literal = p.value
      }
      continue
    }
    links.push([id, p.origin_id, p.origin_slot, p.target_id, p.target_slot, '*'])
    const src = byId.get(Number(p.origin_id))
    if (src?.outputs?.[p.origin_slot]) src.outputs[p.origin_slot].links.push(id)
    const dst = byId.get(Number(p.target_id))
    if (dst?.inputs?.[p.target_slot]) dst.inputs[p.target_slot].link = id
  }

  // 清掉悬空 link：子图内部节点的 inputs[].link 仍指向旧编号，若该连线没被重建就置 null
  const liveLinks = new Set(links.map((l) => l[0]))
  for (const n of outNodes) {
    for (const inp of n.inputs ?? []) {
      if (inp.link !== null && inp.link !== undefined && !liveLinks.has(inp.link)) inp.link = null
    }
  }

  return { graph: { ...graph, nodes: outNodes, links, definitions: {} }, report }
}

/** 扁平 UI 图 → API 工作流。返回 { ok:true, workflow, warnings } | { ok:false, error }。 */
export function convert(graph, objectInfo) {
  const nodes = graph.nodes
  const nodesById = new Map(nodes.map((n) => [n.id, n]))
  const links = new Map((graph.links ?? []).map(toObjectLink).map((l) => [l.id, l]))

  // mode===4 是「旁路」（节点被 Ctrl+B 停用）：输出直接跟随第一个已连输入
  const resolve = (nodeId, slot) => {
    let cur = nodesById.get(Number(nodeId))
    let guard = 0
    while (cur && cur.mode === 4 && guard++ < 32) {
      const entry = (cur.inputs ?? []).find((x) => x.link !== null && x.link !== undefined)
      if (!entry) return undefined
      const l = links.get(entry.link)
      if (!l) return undefined
      cur = nodesById.get(Number(l.origin_id))
      slot = l.origin_slot
    }
    return cur ? [String(cur.id), slot] : undefined
  }

  const workflow = {}
  const warnings = []
  for (const node of nodes) {
    if (!node.type || node.type === 'Reroute') continue
    if (node.mode === 4) continue
    if (isUiOnlyNode(node.type, objectInfo)) continue
    if (objectInfo[node.type] === undefined) {
      const used = (node.outputs ?? []).some((o) => (o.links ?? []).some((id) => links.has(id)))
      if (!used || node.type.startsWith('Primitive')) continue
      return { ok: false, error: `未注册的 UI-only 节点 "${node.type}"（id ${node.id}）` }
    }

    const inputs = zipWidgets(node.type, objectInfo, node.widgets_values)
    for (const entry of node.inputs ?? []) {
      const key = normalizeInputName(entry.name, node.type, objectInfo)
      if (entry.link !== null && entry.link !== undefined) {
        const r = resolve(links.get(entry.link)?.origin_id, links.get(entry.link)?.origin_slot)
        if (r !== undefined) inputs[key] = r
        else warnings.push(`节点 ${node.type}（id ${node.id}）的输入 ${entry.name} 连线无法解析`)
      } else if (entry.literal !== undefined) {
        inputs[key] = entry.literal
      }
    }
    workflow[String(node.id)] = { class_type: node.type, inputs }
  }

  if (Object.keys(workflow).length === 0) return { ok: false, error: '转换结果为空' }

  // 校验一：引用完整性——每个 [nodeId, slot] 必须指向本次输出内的节点
  for (const [id, node] of Object.entries(workflow)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && workflow[value[0]] === undefined) {
        return { ok: false, error: `节点 ${node.class_type}（id ${id}）的 ${name} 引用了范围外节点 ${value[0]}` }
      }
    }
  }

  // 校验二：必需输入缺失（lazy / 模板型 / DynamicCombo 主项 / min=0 的 Autogrow 组可缺）
  for (const [id, node] of Object.entries(workflow)) {
    const def = objectInfo[node.class_type]
    const required = def?.input?.required ?? {}
    const missing = Object.keys(required).filter((name) => {
      if (name in node.inputs) return false
      const spec = required[name]
      const opts = Array.isArray(spec) ? spec[1] : undefined
      if (opts?.lazy === true || opts?.template !== undefined) return false
      if (Array.isArray(spec) && spec[0] === 'COMFY_DYNAMICCOMBO_V3') return false
      if (Array.isArray(spec) && spec[0] === 'COMFY_AUTOGROW_V3') {
        return (opts?.template?.min ?? 1) > 0
      }
      return true
    })
    if (missing.length > 0) {
      return { ok: false, error: `节点 ${node.class_type}（id ${id}）缺少必需输入：${missing.join('、')}` }
    }
  }

  return { ok: true, workflow, warnings }
}

/** 一次到位：图工作流 JSON → API 工作流。 */
export function convertWorkflowFile(raw, objectInfo) {
  const { graph, report } = expandSubgraphs(raw)
  const res = convert(graph, objectInfo)
  return { report, ...res }
}

async function loadObjectInfo({ baseUrl, objectInfoPath }) {
  if (objectInfoPath !== undefined) return JSON.parse(readFileSync(objectInfoPath, 'utf8'))
  const res = await fetch(`${baseUrl}/object_info`)
  if (!res.ok) throw new Error(`从 ${baseUrl}/object_info 拉取节点契约失败：HTTP ${res.status}`)
  return await res.json()
}

// ------------------------------------------------------------------ CLI
const argv = process.argv.slice(2)
const positional = []
const opts = { baseUrl: 'http://127.0.0.1:8188', objectInfoPath: undefined, quiet: false }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--base-url') opts.baseUrl = argv[++i]
  else if (a === '--object-info') opts.objectInfoPath = argv[++i]
  else if (a === '--quiet') opts.quiet = true
  else positional.push(a)
}

const [file, out] = positional
if (file !== undefined) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const objectInfo = await loadObjectInfo(opts)
  const res = convertWorkflowFile(raw, objectInfo)
  console.log(res.report.join('\n'))
  if (!res.ok) {
    console.log('CONVERT FAIL:', res.error)
    process.exit(1)
  }
  if (res.warnings.length > 0) console.log('warnings:', JSON.stringify(res.warnings))
  console.log('API nodes:', Object.keys(res.workflow).length)
  if (!opts.quiet) console.log(JSON.stringify(res.workflow, null, 1))
  if (out !== undefined) {
    writeFileSync(out, JSON.stringify(res.workflow, null, 1))
    console.log(`written: ${out}`)
  }
}
