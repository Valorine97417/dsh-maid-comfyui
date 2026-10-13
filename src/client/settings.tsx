/**
 * The ComfyUI settings page (settings.section, id 'comfyui'). Reads the
 * redacted host config over /comfyui/config, persists edits through the same
 * route, and probes the server over /comfyui/test.
 */
import { createElement as h, useEffect, useState } from 'react'
import { getJson, postJson } from './api.ts'
import { getLang, setLang, type Lang } from './i18n.ts'

export interface ComfyUISettingsProps {
  t: (key: string, ...rest: unknown[]) => string
  close: () => void
}

interface ConfigView {
  baseUrl: string
  apiKeyEnv: string
  hasApiKey: boolean
  timeoutMs: number
  pollIntervalMs: number
  maxMediaItems: number
  mediaHost: string
  comfyuiDirs: string[]
  launchCommand: string
  launchDir: string
  /** Idle minutes after which a plugin-started ComfyUI is stopped; 0 disables. */
  idleShutdownMinutes: number
  idleState: { armed: boolean; port: number | null; idleMs: number; minutes: number }
  canShutdown: boolean
  skillsDir: string
  /** The path packs actually use, including the `<dataDir>/skills` default. */
  skillsRoot: string
  writable: boolean
}

interface TestResult {
  ok: boolean
  text: string
}

/** The ComfyUI settings page component. */
export function ComfyUISettings({ t }: ComfyUISettingsProps): ReturnType<typeof h> {
  const [config, setConfig] = useState<ConfigView | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKeyEnv, setApiKeyEnv] = useState('')
  const [mediaHost, setMediaHost] = useState('')
  const [comfyuiDirs, setComfyuiDirs] = useState<string[]>([])
  const [launchCommand, setLaunchCommand] = useState('')
  const [launchDir, setLaunchDir] = useState('')
  const [idleMinutes, setIdleMinutes] = useState('10')
  const [skillsDir, setSkillsDir] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'failed'>('idle')
  const [testing, setTesting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopNote, setStopNote] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [lang, setLangState] = useState<Lang>(getLang())

  useEffect(() => {
    let cancelled = false
    getJson<ConfigView>('/comfyui/config').then((view) => {
      if (cancelled) return
      setConfig(view)
      setBaseUrl(view.baseUrl)
      setApiKeyEnv(view.apiKeyEnv)
      setMediaHost(view.mediaHost ?? '')
      setComfyuiDirs(Array.isArray(view.comfyuiDirs) ? view.comfyuiDirs : [])
      setLaunchCommand(view.launchCommand ?? '')
      setLaunchDir(view.launchDir ?? '')
      setIdleMinutes(String(view.idleShutdownMinutes ?? 10))
      setSkillsDir(view.skillsDir ?? '')
    }).catch((error: unknown) => {
      if (cancelled) return
      setLoadError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [])

  /** The idle field is free text; a blank or nonsense value keeps the default.
   * The host schema clamps the rest (0 = never stop, 1440 = a day). */
  const idleMinutesNumber = (): number => {
    const parsed = Number(idleMinutes.trim())
    return Number.isFinite(parsed) && parsed >= 0 ? Math.min(Math.round(parsed), 1_440) : 10
  }

  const idleStatusText = (): string => {
    if (stopNote !== null) return stopNote
    const minutes = idleMinutesNumber()
    const state = config?.idleState
    if (minutes === 0) return t('idleDisabled')
    if (state === undefined || !state.armed) return t('idleNotLaunched')
    return t('idleArmed', { minutes: String(Math.round(state.idleMs / 60_000)) })
  }

  /** Stop a server this plugin started, without waiting out the idle window. */
  const stopNow = async (): Promise<void> => {
    setStopping(true)
    setStopNote(null)
    try {
      const result = (await postJson('/comfyui/idle/stop', {})) as { ok?: boolean; stopped?: boolean; error?: string }
      if (result.ok === true && result.stopped === true) {
        setStopNote(t('stopped'))
      } else {
        setStopNote(`${t('stopFailed')}${result.error !== undefined ? ` (${result.error})` : ''}`)
      }
    } catch (error) {
      setStopNote(`${t('stopFailed')} (${error instanceof Error ? error.message : String(error)})`)
    } finally {
      setStopping(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveState('idle')
    try {      // Trim blanks and drop empty rows before persisting.
      const dirs = comfyuiDirs.map((dir) => dir.trim()).filter((dir) => dir !== '')
      const payload = (await postJson('/comfyui/config', { patch: { baseUrl, apiKeyEnv, mediaHost, comfyuiDirs: dirs, launchCommand: launchCommand.trim(), launchDir: launchDir.trim(), idleShutdownMinutes: idleMinutesNumber(), skillsDir: skillsDir.trim() } })) as { config?: ConfigView }
      if (payload.config !== undefined) {
        setConfig(payload.config)
        setBaseUrl(payload.config.baseUrl)
        setApiKeyEnv(payload.config.apiKeyEnv)
        setMediaHost(payload.config.mediaHost ?? '')
        setComfyuiDirs(payload.config.comfyuiDirs ?? [])
        setLaunchCommand(payload.config.launchCommand ?? '')
        setLaunchDir(payload.config.launchDir ?? '')
        setIdleMinutes(String(payload.config.idleShutdownMinutes ?? idleMinutesNumber()))
        setSkillsDir(payload.config.skillsDir ?? '')
      }
      setSaveState('saved')
    } catch (error) {
      setSaveState('failed')
      setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const payload = (await postJson('/comfyui/test', {})) as { ok: boolean; version?: string; latencyMs?: number; error?: string }
      if (payload.ok === true) {
        setTestResult({ ok: true, text: t('testOk', { version: payload.version ?? 'unknown', ms: payload.latencyMs ?? 0 }) })
      } else {
        setTestResult({ ok: false, text: t('testFail', { message: payload.error ?? 'unknown error' }) })
      }
    } catch (error) {
      setTestResult({ ok: false, text: t('testFail', { message: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setTesting(false)
    }
  }

  if (loadError !== null) {
    return h('div', { className: 'dsc-card' },
      h('div', { className: 'dsc-meta' }, `${t('saveFailed')}: ${loadError}`),
    )
  }
  if (config === null) {
    return h('div', { className: 'dsc-card' }, h('div', { className: 'dsc-meta' }, '…'))
  }

  return h('div', { className: 'dsc-form' },
    h('div', { className: 'dsc-meta' }, t('settingsDesc')),
    h('div', { className: 'dsc-field' },
      h('label', null, t('language')),
      h('select', {
        className: 'dsc-input',
        value: lang,
        onChange: (event: { target: { value: string } }) => {
          const next: Lang = event.target.value === 'en' ? 'en' : 'zh'
          setLangState(next)
          setLang(next)
          window.location.reload()
        },
      },
        h('option', { value: 'zh' }, '中文'),
        h('option', { value: 'en' }, 'English'),
      ),
      h('div', { className: 'dsc-hint' }, t('languageHint')),
    ),
    h('div', { className: 'dsc-field' },
      h('label', null, t('baseUrl')),
      h('input', {
        value: baseUrl,
        placeholder: 'http://127.0.0.1:8188',
        onChange: (event: { target: { value: string } }) => { setBaseUrl(event.target.value); setSaveState('idle') },
      }),
      h('div', { className: 'dsc-hint' }, t('baseUrlHint')),
    ),
    h('div', { className: 'dsc-field' },
      h('label', null, t('launchCommand')),
      h('input', {
        className: 'dsc-input',
        value: launchCommand,
        placeholder: 'D:\\ComfyUI_windows_portable\\run_nvidia_gpu.bat',
        onChange: (event: { target: { value: string } }) => { setLaunchCommand(event.target.value); setSaveState('idle') },
      }),
      h('div', { className: 'dsc-hint' }, t('launchCommandHint')),
    ),
    h('div', { className: 'dsc-field' },
      h('label', null, t('launchDir')),
      h('input', {
        className: 'dsc-input',
        value: launchDir,
        placeholder: 'D:\\ComfyUI_windows_portable',
        onChange: (event: { target: { value: string } }) => { setLaunchDir(event.target.value); setSaveState('idle') },
      }),
      h('div', { className: 'dsc-hint' }, t('launchDirHint')),
    ),
    h('div', { className: 'dsc-field' },
      h('label', null, t('idleShutdownMinutes')),
      h('input', {
        className: 'dsc-input',
        value: idleMinutes,
        placeholder: '10',
        inputMode: 'numeric',
        onChange: (event: { target: { value: string } }) => { setIdleMinutes(event.target.value); setSaveState('idle') },
      }),
      h('div', { className: 'dsc-hint' }, t('idleShutdownMinutesHint')),
      h('div', { className: 'dsc-hint' }, idleStatusText()),
      config.canShutdown
        ? h('button', {
          className: 'dsc-btn',
          disabled: stopping,
          onClick: () => void stopNow(),
        }, stopping ? t('stopping') : t('stopNow'))
        : null,
    ),
    h('div', { className: 'dsc-field' },
      h('label', null, t('apiKeyEnv')),
      h('input', {
        value: apiKeyEnv,
        placeholder: 'COMFYUI_API_KEY',
        onChange: (event: { target: { value: string } }) => { setApiKeyEnv(event.target.value); setSaveState('idle') },
      }),
      h('div', { className: 'dsc-hint' }, `${t('apiKeyEnvHint')} — ${config.hasApiKey ? t('hasApiKey') : t('noApiKey')}`),
    ),
    h('div', { className: 'dsc-field' },
      h('label', null, t('mediaHost')),
      h('input', {
        value: mediaHost,
        placeholder: 'http://192.168.1.5:3080',
        onChange: (event: { target: { value: string } }) => { setMediaHost(event.target.value); setSaveState('idle') },
      }),
      h('div', { className: 'dsc-hint' }, t('mediaHostHint')),
    ),
    h('div', { className: 'dsc-field' },
      h('label', null, t('comfyuiDirs')),
      comfyuiDirs.map((dir, index) => h('div', {
        key: `dsc-dir-${index}`,
        style: { display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' },
      },
        h('input', {
          className: 'dsc-input',
          value: dir,
          placeholder: t('comfyuiDirPlaceholder'),
          style: { flex: '1' },
          onChange: (event: { target: { value: string } }) => {
            const next = comfyuiDirs.slice()
            next[index] = event.target.value
            setComfyuiDirs(next)
            setSaveState('idle')
          },
        }),
        h('button', {
          className: 'dsc-btn',
          title: t('comfyuiDirRemove'),
          disabled: !config.writable,
          onClick: () => {
            const next = comfyuiDirs.slice()
            next.splice(index, 1)
            setComfyuiDirs(next)
            setSaveState('idle')
          },
        }, '×'),
      )),
      h('button', {
        className: 'dsc-btn',
        disabled: !config.writable,
        onClick: () => {
          setComfyuiDirs([...comfyuiDirs, ''])
          setSaveState('idle')
        },
      }, t('comfyuiDirAdd')),
      h('div', { className: 'dsc-hint' }, t('comfyuiDirsHint')),
    ),
    h('div', { className: 'dsc-field' },
      h('label', null, t('skillsDir')),
      h('input', {
        className: 'dsc-input',
        value: skillsDir,
        placeholder: config.skillsRoot,
        onChange: (event: { target: { value: string } }) => { setSkillsDir(event.target.value); setSaveState('idle') },
      }),
      h('div', { className: 'dsc-hint' }, t('skillsDirHint', { current: config.skillsRoot })),
    ),
    h('div', { className: 'dsc-row' },
      h('button', { className: 'dsc-btn', disabled: saving || !config.writable, onClick: () => void save() }, t('save')),
      h('button', { className: 'dsc-btn', disabled: testing, onClick: () => void test() }, testing ? t('testing') : t('test')),
      saveState === 'saved' ? h('span', { className: 'dsc-note' }, t('saved')) : null,
      saveState === 'failed' ? h('span', { className: 'dsc-note' }, t('saveFailed')) : null,
    ),
    testResult !== null
      ? h('div', { className: testResult.ok ? 'dsc-note' : 'dsc-note', style: testResult.ok ? { color: '#22c55e' } : { color: '#ef4444' } }, testResult.text)
      : null,
    config.writable ? null : h('div', { className: 'dsc-hint' }, t('configNotWritable')),
  )
}
