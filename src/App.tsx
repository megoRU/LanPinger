import {useCallback, useEffect, useId, useMemo, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen, type UnlistenFn} from "@tauri-apps/api/event";
import {getVersion} from "@tauri-apps/api/app";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {relaunch} from "@tauri-apps/plugin-process";
import {check, type Update} from "@tauri-apps/plugin-updater";
import {
  ArrowDownToLine,
  ChevronDown,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  History,
  Moon,
  Network,
  Play,
  RefreshCw,
  Settings,
  ShieldCheck,
  Square,
  Sun,
  X,
} from "lucide-react";

type RunStatus = "idle" | "resolving" | "tracing" | "running" | "stopping" | "stopped" | "error";
type Theme = "dark" | "light";
type Language = "en" | "ru";
type LanguagePreference = "system" | Language;

interface HopRow {
  hop: number;
  host: string;
  ip: string;
  sent: number;
  received: number;
  lossPercent: number;
  bestMs: number | null;
  averageMs: number | null;
  worstMs: number | null;
  lastMs: number | null;
  jitterMs: number | null;
  status: "responding" | "timeout" | "destination" | "stale";
}

interface MonitorStatusEvent {
  sessionId: string;
  status: RunStatus;
  host: string;
  resolvedIp: string | null;
  message: string | null;
}

interface MonitorUpdateEvent {
  sessionId: string;
  host: string;
  resolvedIp: string;
  elapsedMs: number;
  reachedDestination: boolean;
  rows: HopRow[];
}

const DEFAULT_INTERVAL = 1_000;
const LEGACY_DEFAULT_INTERVAL = 5_000;
const INTERVAL_DEFAULT_MIGRATION_KEY = "lanpinger.interval.default-v1";
const LANGUAGE_KEY = "lanpinger.language";
const TARGET_HISTORY_KEY = "lanpinger.target-history";
const TARGET_HISTORY_LIMIT = 12;
const INTERVALS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

const translations = {
  en: {
    ready: "Ready to trace a route",
    monitoringPartial: "Monitoring with partial replies",
    monitoring: "Monitoring",
    resolving: "Resolving",
    tracing: "Tracing",
    stopping: "Stopping",
    error: "Error",
    idle: "Idle",
    exportResults: "Export results",
    exportText: "Export as text",
    textSaveFolder: "Text report folder",
    textSaveFolderDescription: "Folder where exported TXT reports are saved",
    textSaveFolderPlaceholder: "Enter a folder path",
    textSaveFolderRequired: "Set a folder path in Settings first",
    settings: "Settings",
    aboutUpdates: "About and updates",
    routeControls: "Route monitor controls",
    target: "TARGET",
    domainOrIp: "Domain or IP address",
    hostNameOrIp: "Host name or IP address",
    unresolved: "unresolved",
    clearHost: "Clear host",
    recentSearches: "Recent searches",
    clearHistory: "Clear history",
    removeHistoryItem: "Remove from history",
    traceInterval: "TRACE INTERVAL",
    traceIntervalTitle: "Trace interval",
    start: "Start",
    stop: "Stop",
    icmpTitle: "ICMP Echo probes with increasing TTL / hop limit",
    routeStatistics: "Route statistics",
    elapsed: "Elapsed",
    routeOverview: "Route overview",
    livePathTo: "Live path to {host}",
    startTracePrompt: "Start a trace to discover each network hop",
    replies: "replies",
    probes: "probes",
    live: "LIVE",
    hop: "HOP",
    host: "HOST",
    ipAddress: "IP ADDRESS",
    loss: "LOSS",
    sent: "SENT",
    received: "RECV",
    best: "BEST",
    average: "AVERAGE",
    worst: "WORST",
    last: "LAST",
    jitter: "JITTER",
    state: "STATE",
    copyIp: "Copy IP address",
    destination: "Destination",
    responding: "Responding",
    priorRoute: "Prior route",
    noReply: "No reply",
    traceCouldNotStart: "Trace could not start",
    discoveringRoute: "Discovering the route",
    noRouteData: "No route data yet",
    discoveringDescription: "LanPinger is resolving the target and probing hop limits. Results will appear here.",
    emptyDescription: "Enter a domain name or IP address above, then start a trace to see live hop statistics.",
    enterTarget: "Enter a target",
    localDiagnostics: "Local diagnostics",
    checking: "Checking",
    updateVersion: "Update {version}",
    noTelemetry: "No telemetry",
    updateAvailable: "Update available: {version}",
    preferences: "Preferences",
    preferencesDescription: "Adjust how LanPinger appears and measures.",
    intervalSettingDescription: "Pause between full route sweeps",
    appearance: "Appearance",
    appearanceDescription: "Choose your preferred color theme",
    dark: "Dark",
    light: "Light",
    language: "Language",
    languageDescription: "Choose the interface language",
    systemLanguage: "System default ({language})",
    russian: "Русский",
    english: "English",
    closeSettings: "Close settings",
    checkingUpdates: "Checking for updates",
    upToDate: "You’re up to date",
    versionReady: "Version {version} is ready",
    versionAvailable: "Version {version} available",
    updateCheckFailed: "Update check failed: {details}",
    signedUpdateReady: "A signed update is ready to download and install.",
    downloadingUpdate: "Downloading update",
    checkAgain: "Check for updates",
    installRestart: "Install and restart",
    downloadComplete: "Download complete. Restarting…",
    downloadingVersion: "Downloading version {version}…",
    installationFailed: "Installation failed: {details}",
    readyToTrace: "Ready to trace a route",
    enterHostError: "Enter a host name or IP address",
    resolvingDestinationName: "Resolving destination name…",
    stoppingMeasurement: "Stopping the active measurement…",
    clipboardUnavailable: "Clipboard access is unavailable",
    textSaved: "Text report saved",
    copied: "Copied {value}",
    statusResolvingDestination: "Resolving the destination name",
    statusDiscoveringRoute: "Destination resolved; discovering the route",
    statusStopping: "Stopping the active measurement",
    traceTimeLimit: "Trace reached its time limit; continuing with the next cycle",
    noDestinationResponse: "No destination response; intermediate routers may filter ICMP",
    routeProbeFailed: "The route probe failed",
    enterHostValidation: "The host name or IP address is invalid.",
    invalidHost: "The host name contains an invalid character.",
    invalidHostLength: "The host name is too long or contains spaces.",
    invalidDomain: "Use an IP address or a valid domain name.",
    invalidDomainLabel: "The domain name could not be converted to a valid network name.",
    invalidInterval: "The trace interval must be between 1 and 60 seconds.",
    monitorAlreadyRunning: "A route monitor is already running.",
    dnsTimeout: "DNS lookup timed out after 8 seconds.",
    dnsFailure: "DNS lookup failed: {details}",
    dnsEmpty: "DNS returned no IPv4 or IPv6 addresses.",
    icmpFailure: "ICMP route probe failed: {details}",
    icmpPermission: "ICMP socket permission denied. {details}",
  },
  ru: {
    ready: "Готов к трассировке маршрута",
    monitoringPartial: "Мониторинг: получены не все ответы",
    monitoring: "Мониторинг",
    resolving: "Определение адреса",
    tracing: "Трассировка",
    stopping: "Остановка",
    error: "Ошибка",
    idle: "Ожидание",
    exportResults: "Экспорт результатов",
    exportText: "Экспортировать как текст",
    textSaveFolder: "Папка для TXT-отчётов",
    textSaveFolderDescription: "Папка, в которую сохраняются текстовые отчёты",
    textSaveFolderPlaceholder: "Укажите путь к папке",
    textSaveFolderRequired: "Сначала укажите путь к папке в настройках",
    settings: "Настройки",
    aboutUpdates: "О программе и обновления",
    routeControls: "Управление мониторингом маршрута",
    target: "АДРЕС НАЗНАЧЕНИЯ",
    domainOrIp: "Домен или IP-адрес",
    hostNameOrIp: "Имя хоста или IP-адрес",
    unresolved: "не определён",
    clearHost: "Очистить адрес",
    recentSearches: "Недавние адреса",
    clearHistory: "Очистить историю",
    removeHistoryItem: "Удалить из истории",
    traceInterval: "ИНТЕРВАЛ ТРАССИРОВКИ",
    traceIntervalTitle: "Интервал трассировки",
    start: "Старт",
    stop: "Стоп",
    icmpTitle: "ICMP Echo-пробы с увеличением TTL / лимита переходов",
    routeStatistics: "Статистика маршрута",
    elapsed: "Время",
    routeOverview: "Маршрут",
    livePathTo: "Текущий маршрут до {host}",
    startTracePrompt: "Запустите трассировку, чтобы увидеть сетевые узлы",
    replies: "ответов",
    probes: "проб",
    live: "ИДЁТ",
    hop: "УЗЕЛ",
    host: "ХОСТ",
    ipAddress: "IP-АДРЕС",
    loss: "ПОТЕРИ",
    sent: "ОТПР.",
    received: "ПОЛУЧ.",
    best: "МИН.",
    average: "СРЕДНЕЕ",
    worst: "МАКС.",
    last: "ПОСЛЕДНЕЕ",
    jitter: "ДЖИТТЕР",
    state: "СОСТОЯНИЕ",
    copyIp: "Скопировать IP-адрес",
    destination: "Назначение",
    responding: "Отвечает",
    priorRoute: "Прежний маршрут",
    noReply: "Нет ответа",
    traceCouldNotStart: "Не удалось запустить трассировку",
    discoveringRoute: "Определяем маршрут",
    noRouteData: "Данных о маршруте пока нет",
    discoveringDescription: "LanPinger определяет адрес и проверяет сетевые узлы. Результаты появятся здесь.",
    emptyDescription: "Введите доменное имя или IP-адрес и запустите трассировку, чтобы увидеть статистику узлов.",
    enterTarget: "Введите адрес",
    localDiagnostics: "Локальная диагностика",
    checking: "Проверка…",
    updateVersion: "Обновить до {version}",
    noTelemetry: "Без телеметрии",
    updateAvailable: "Доступно обновление {version}",
    preferences: "Параметры",
    preferencesDescription: "Настройте внешний вид и измерения LanPinger.",
    intervalSettingDescription: "Пауза между полными проходами маршрута",
    appearance: "Оформление",
    appearanceDescription: "Выберите цветовую тему",
    dark: "Тёмная",
    light: "Светлая",
    language: "Язык",
    languageDescription: "Язык интерфейса приложения",
    systemLanguage: "Как в системе ({language})",
    russian: "Русский",
    english: "Английский",
    closeSettings: "Закрыть настройки",
    checkingUpdates: "Проверка обновлений",
    upToDate: "Установлена последняя версия",
    versionReady: "Версия {version} готова к установке",
    versionAvailable: "Доступна версия {version}",
    updateCheckFailed: "Не удалось проверить обновления: {details}",
    signedUpdateReady: "Подписанное обновление готово к загрузке и установке.",
    downloadingUpdate: "Загрузка обновления",
    checkAgain: "Проверить обновление",
    installRestart: "Установить и перезапустить",
    downloadComplete: "Загрузка завершена. Перезапуск…",
    downloadingVersion: "Загрузка версии {version}…",
    installationFailed: "Не удалось установить обновление: {details}",
    readyToTrace: "Готов к трассировке маршрута",
    enterHostError: "Введите имя хоста или IP-адрес",
    resolvingDestinationName: "Определяем адрес назначения…",
    stoppingMeasurement: "Останавливаем измерения…",
    clipboardUnavailable: "Буфер обмена недоступен",
    textSaved: "Текстовый отчёт сохранён",
    copied: "Скопировано: {value}",
    statusResolvingDestination: "Определяем имя назначения",
    statusDiscoveringRoute: "Адрес определён; ищем маршрут",
    statusStopping: "Останавливаем измерения",
    traceTimeLimit: "Время трассировки истекло; запускаем следующий проход",
    noDestinationResponse: "Назначение не ответило; промежуточные узлы могут фильтровать ICMP",
    routeProbeFailed: "Не удалось выполнить трассировку",
    enterHostValidation: "Укажите корректное имя хоста или IP-адрес.",
    invalidHost: "В имени хоста есть недопустимые символы.",
    invalidHostLength: "Имя хоста слишком длинное или содержит пробелы.",
    invalidDomain: "Укажите IP-адрес или корректное доменное имя.",
    invalidDomainLabel: "Не удалось преобразовать доменное имя в допустимый сетевой адрес.",
    invalidInterval: "Интервал трассировки должен быть от 1 до 60 секунд.",
    monitorAlreadyRunning: "Мониторинг маршрута уже запущен.",
    dnsTimeout: "Время ожидания ответа DNS истекло (8 секунд).",
    dnsFailure: "Ошибка DNS: {details}",
    dnsEmpty: "DNS не вернул IPv4- или IPv6-адресов.",
    icmpFailure: "Ошибка ICMP-трассировки: {details}",
    icmpPermission: "Нет разрешения на ICMP. {details}",
  },
} as const;

type TranslationKey = keyof typeof translations.en;

function getSystemLanguage(): Language {
  const locale = navigator.language || navigator.languages?.[0] || "en";
  return locale.toLowerCase().startsWith("ru") ? "ru" : "en";
}

function getLanguagePreference(): LanguagePreference {
  const saved = localStorage.getItem(LANGUAGE_KEY);
  return saved === "ru" || saved === "en" || saved === "system" ? saved : "system";
}

function getTargetHistory(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(TARGET_HISTORY_KEY) ?? "[]");
    return Array.isArray(saved)
      ? saved.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, TARGET_HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function localizeMessage(message: string, language: Language): string {
  if (language === "en") return message;
  const exact: Partial<Record<string, TranslationKey>> = {
    "Ready to trace a route": "ready",
    "Monitoring with partial replies": "monitoringPartial",
    "Enter a host name or IP address": "enterHostError",
    "Resolving destination name…": "resolvingDestinationName",
    "Stopping the active measurement…": "stoppingMeasurement",
    "Clipboard access is unavailable": "clipboardUnavailable",
    "Text report saved": "textSaved",
    "Resolving the destination name": "statusResolvingDestination",
    "Destination resolved; discovering the route": "statusDiscoveringRoute",
    "Stopping the active measurement": "statusStopping",
    "Trace reached its time limit; continuing with the next cycle": "traceTimeLimit",
    "No destination response; intermediate routers may filter ICMP": "noDestinationResponse",
    "The route probe failed": "routeProbeFailed",
    "Enter a host name or IP address.": "enterHostValidation",
    destination: "destination",
    responding: "responding",
    stale: "priorRoute",
    timeout: "noReply",
    "The host name contains an invalid character.": "invalidHost",
    "The host name is too long or contains spaces.": "invalidHostLength",
    "Use an IP address or a valid domain name.": "invalidDomain",
    "The domain name could not be converted to a valid network name.": "invalidDomainLabel",
    "The trace interval must be between 1 and 60 seconds.": "invalidInterval",
    "A route monitor is already running.": "monitorAlreadyRunning",
    "DNS lookup timed out after 8 seconds.": "dnsTimeout",
    "DNS returned no IPv4 or IPv6 addresses.": "dnsEmpty",
    "You’re up to date": "upToDate",
    "Checking for updates": "checkingUpdates",
    "Checking for updates…": "checkingUpdates",
    "Download complete. Restarting…": "downloadComplete",
  };
  const key = exact[message];
  if (key) return translations.ru[key];
  const copied = /^Copied (.+)$/.exec(message);
  if (copied) return translations.ru.copied.replace("{value}", copied[1]);
  const versionReady = /^Version (.+) is ready$/.exec(message);
  if (versionReady) return translations.ru.versionReady.replace("{version}", versionReady[1]);
  const downloadingVersion = /^Downloading version (.+)…$/.exec(message);
  if (downloadingVersion) return translations.ru.downloadingVersion.replace("{version}", downloadingVersion[1]);
  const updateCheckError = /^Update check failed: (.*)$/.exec(message);
  if (updateCheckError) return translations.ru.updateCheckFailed.replace("{details}", updateCheckError[1]);
  const installError = /^Installation failed: (.*)$/.exec(message);
  if (installError) return translations.ru.installationFailed.replace("{details}", installError[1]);
  const dnsError = /^DNS lookup failed: (.*)$/.exec(message);
  if (dnsError) return translations.ru.dnsFailure.replace("{details}", dnsError[1]);
  const icmpError = /^ICMP route probe failed: (.*)$/.exec(message);
  if (icmpError) return translations.ru.icmpFailure.replace("{details}", icmpError[1]);
  const permissionError = /^ICMP socket permission denied\. (.*)$/.exec(message);
  if (permissionError) return translations.ru.icmpPermission.replace("{details}", permissionError[1]);
  return message;
}

function formatMs(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)} ms`;
}

function normalizeTargetInput(value: string) {
  const withoutScheme = value.trim().replace(/^https?:\/\/+/i, "").trim();
  return withoutScheme.split(/[/?#]/, 1)[0].trim().replace(/\/+$/, "");
}

function formatLoss(value: number) {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatInterval(milliseconds: number, language: Language) {
  const seconds = milliseconds / 1000;
  if (language === "en") return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const unit = russianPlural(seconds, "секунда", "секунды", "секунд");
  return `${seconds} ${unit}`;
}

function russianPlural(value: number, one: string, few: string, many: string) {
  const lastTwoDigits = value % 100;
  const lastDigit = value % 10;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return many;
  if (lastDigit === 1) return one;
  if (lastDigit >= 2 && lastDigit <= 4) return few;
  return many;
}

function makeFilename(host: string, extension: string) {
  const safeHost = host.trim().replace(/[^a-z0-9.-]+/gi, "_").slice(0, 80) || "route";
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return `lanpinger-${safeHost}-${stamp}.${extension}`;
}

type SettingValue = string | number;

interface SettingOption {
  value: SettingValue;
  label: string;
}

interface SettingSelectProps {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onChange: (value: SettingValue) => void;
  options: SettingOption[];
  value: SettingValue;
}

function SettingSelect({ariaLabel, className = "", disabled = false, onChange, options, value}: SettingSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    };
  }, [open, selectedIndex]);

  const focusOption = (index: number) => {
    const nextIndex = (index + options.length) % options.length;
    optionRefs.current[nextIndex]?.focus();
  };

  const closeAndFocusTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={`setting-select ${className} ${open ? "is-open" : ""}`}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="setting-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            window.requestAnimationFrame(() => focusOption(selectedIndex));
          }
        }}
      >
        <span>{options[selectedIndex]?.label}</span><ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div id={listId} className="setting-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                ref={(element) => { optionRefs.current[index] = element; }}
                type="button"
                className={`setting-select-option ${selected ? "selected" : ""}`}
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  closeAndFocusTrigger();
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") { event.preventDefault(); focusOption(index + 1); }
                  else if (event.key === "ArrowUp") { event.preventDefault(); focusOption(index - 1); }
                  else if (event.key === "Home") { event.preventDefault(); focusOption(0); }
                  else if (event.key === "End") { event.preventDefault(); focusOption(options.length - 1); }
                  else if (event.key === "Escape") { event.preventDefault(); closeAndFocusTrigger(); }
                }}
              >
                <span>{option.label}</span>{selected && <Check size={14} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function App() {
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(getLanguagePreference);
  const language: Language = languagePreference === "system" ? getSystemLanguage() : languagePreference;
  const t = (key: TranslationKey, values: Record<string, string | number> = {}) => {
    let value: string = translations[language][key];
    for (const [name, replacement] of Object.entries(values)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
    return value;
  };
  const displayMessage = (message: string) => localizeMessage(message, language);
  const [host, setHost] = useState("");
  const [targetHistory, setTargetHistory] = useState<string[]>(getTargetHistory);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [intervalMs, setIntervalMs] = useState<number>(() => {
    const saved = Number(localStorage.getItem("lanpinger.interval"));
    const needsDefaultMigration = localStorage.getItem(INTERVAL_DEFAULT_MIGRATION_KEY) !== "done";
    if (needsDefaultMigration && saved === LEGACY_DEFAULT_INTERVAL) return DEFAULT_INTERVAL;
    return INTERVALS.includes(saved as (typeof INTERVALS)[number]) ? saved : DEFAULT_INTERVAL;
  });
  const [theme, setTheme] = useState<Theme>(() => {
    const initialTheme = localStorage.getItem("lanpinger.theme") === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = initialTheme;
    return initialTheme;
  });
  const [status, setStatus] = useState<RunStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("Ready to trace a route");
  const [rows, setRows] = useState<HopRow[]>([]);
  const [resolvedIp, setResolvedIp] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [appVersion, setAppVersion] = useState("0.1.3");
  const [textSaveFolder, setTextSaveFolder] = useState(() => localStorage.getItem("lanpinger.text-save-folder") ?? "");
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateState, setUpdateState] = useState("Checking for updates");
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateLength, setUpdateLength] = useState<number | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const checkingUpdateRef = useRef(false);
  const sessionIdRef = useRef("");
  const hostInputRef = useRef<HTMLInputElement>(null);
  const visibleHistory = useMemo(() => {
    const query = host.trim().toLocaleLowerCase();
    return targetHistory
      .filter((target) => !query || target.toLocaleLowerCase().includes(query))
      .slice(0, 8);
  }, [host, targetHistory]);

  const isActive = status === "resolving" || status === "tracing" || status === "running" || status === "stopping";
  const reachedDestination = rows.some((row) => row.status === "destination" && row.lastMs !== null);
  const destinationAnswered = /^Destination answered in \d+ hops$/.test(statusMessage);
  const visibleStatus = reachedDestination || destinationAnswered || status === "resolving" || status === "tracing"
    ? ""
    : status === "running" && rows.length > 0
      ? t("monitoringPartial")
      : displayMessage(statusMessage);
  const isIdleView = status === "idle" || status === "stopped";

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.language = language;
  }, [language]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("lanpinger.theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [settingsOpen]);

  useEffect(() => {
    localStorage.setItem(LANGUAGE_KEY, languagePreference);
  }, [languagePreference]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void getCurrentWindow().show().catch((error: unknown) => {
        console.error("Unable to show the ready application window:", error);
      });
    }, 100);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem("lanpinger.interval", String(intervalMs));
    localStorage.setItem(INTERVAL_DEFAULT_MIGRATION_KEY, "done");
  }, [intervalMs]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn[] = [];
    void Promise.all([
      listen<MonitorStatusEvent>("monitor-status", ({ payload }) => {
        if (sessionIdRef.current && payload.sessionId !== sessionIdRef.current) return;
        if (payload.sessionId) {
          sessionIdRef.current = payload.sessionId;
        }
        setStatus(payload.status);
        if (payload.resolvedIp) setResolvedIp(payload.resolvedIp);
        if (payload.message) setStatusMessage(payload.message);
        if (payload.status === "error" || payload.status === "stopped") {
          if (payload.status === "error") setToast(payload.message ?? "The route probe failed");
        }
      }),
      listen<MonitorUpdateEvent>("monitor-update", ({ payload }) => {
        if (payload.sessionId !== sessionIdRef.current) return;
        setRows(payload.rows);
        setResolvedIp(payload.resolvedIp);
        setElapsedMs(payload.elapsedMs);
        setStatus("running");
      }),
    ]).then((handlers) => {
      if (disposed) handlers.forEach((handler) => handler());
      else unlisten = handlers;
    });
    void getVersion().then((version) => {
      if (!disposed) setAppVersion(version);
    });
    return () => {
      disposed = true;
      unlisten.forEach((handler) => handler());
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (status === "resolving" || status === "tracing" || status === "running") {
        setElapsedMs((value) => value + 1_000);
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    const timer = window.setTimeout(() => setToast(""), 3_200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const checkForUpdates = useCallback(async (quiet = false) => {
    if (checkingUpdateRef.current) return;
    checkingUpdateRef.current = true;
    setCheckingUpdate(true);
    setUpdateProgress(null);
    setUpdateLength(null);
    if (!quiet) setUpdateState("Checking for updates…");
    try {
      const found = await check();
      setUpdate(found);
      setUpdateState(found ? `Version ${found.version} is ready` : "You’re up to date");
    } catch (error) {
      setUpdateState(`Update check failed: ${String(error)}`);
    } finally {
      checkingUpdateRef.current = false;
      setCheckingUpdate(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void checkForUpdates(true), 1_600);
    return () => window.clearTimeout(timer);
  }, [checkForUpdates]);

  const start = async () => {
    const value = normalizeTargetInput(host);
    setHost(value);
    if (!value) {
      setStatusMessage("Enter a host name or IP address");
      hostInputRef.current?.focus();
      return;
    }
    setRows([]);
    setResolvedIp("");
    setElapsedMs(0);
    setStatus("resolving");
    setStatusMessage("Resolving destination name…");
    try {
      sessionIdRef.current = await invoke<string>("start_monitoring", {host: value, intervalMs});
      const nextHistory = [value, ...targetHistory.filter((item) => item.toLocaleLowerCase() !== value.toLocaleLowerCase())]
        .slice(0, TARGET_HISTORY_LIMIT);
      setTargetHistory(nextHistory);
      localStorage.setItem(TARGET_HISTORY_KEY, JSON.stringify(nextHistory));
      setHistoryOpen(false);
    } catch (error) {
      setStatus("error");
      setStatusMessage(String(error));
      setToast(String(error));
    }
  };

  const removeHistoryItem = (target: string) => {
    const nextHistory = targetHistory.filter((item) => item !== target);
    setTargetHistory(nextHistory);
    localStorage.setItem(TARGET_HISTORY_KEY, JSON.stringify(nextHistory));
  };

  const clearHistory = () => {
    setTargetHistory([]);
    localStorage.removeItem(TARGET_HISTORY_KEY);
    setHistoryOpen(false);
  };

  const stop = async () => {
    setStatus("stopping");
    setStatusMessage("Stopping the active measurement…");
    try {
      await invoke("stop_monitoring");
    } catch (error) {
      setStatusMessage(String(error));
    }
  };

  const copyIp = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setToast(`Copied ${value}`);
    } catch {
      setToast("Clipboard access is unavailable");
    }
  };

  const exportText = async () => {
    if (rows.length === 0) return;
    if (!textSaveFolder.trim()) {
      setToast("Set a folder path in Settings first");
      setSettingsOpen(true);
      return;
    }
    const title = `LanPinger ${t("routeOverview")}\n${t("target")}: ${host} (${resolvedIp || t("unresolved")})\n${t("elapsed")}: ${formatDuration(elapsedMs)}\n\n`;
    const header = [t("hop"), t("host"), t("ipAddress"), t("loss"), t("sent"), t("received"), t("best"), t("average"), t("worst"), t("last"), t("jitter"), t("state")].join("\t");
    const body = rows.map((row) => [row.hop, row.host, row.ip, formatLoss(row.lossPercent), row.sent, row.received, formatMs(row.bestMs), formatMs(row.averageMs), formatMs(row.worstMs), formatMs(row.lastMs), formatMs(row.jitterMs), displayMessage(row.status)].join("\t")).join("\n");
    try {
      await invoke("save_text_report", {directory: textSaveFolder, filename: makeFilename(host, "txt"), contents: `\uFEFF${title}${header}\n${body}\n`});
      setToast("Text report saved");
    } catch (error) {
      setToast(String(error));
    }
  };

  const installUpdate = async () => {
    if (!update) return;
    setInstallingUpdate(true);
    setUpdateProgress(0);
    setUpdateState(`Downloading version ${update.version}…`);
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setUpdateProgress(0);
          setUpdateLength(event.data.contentLength ?? null);
        }
        if (event.event === "Progress") {
          setUpdateProgress((current) => (current ?? 0) + event.data.chunkLength);
        }
        if (event.event === "Finished") setUpdateState("Download complete. Restarting…");
      });
      await relaunch();
    } catch (error) {
      setUpdateState(`Installation failed: ${String(error)}`);
      setUpdateProgress(null);
      setInstallingUpdate(false);
    }
  };

  const stats = useMemo(() => {
    const totalSent = rows.reduce((sum, row) => sum + row.sent, 0);
    const totalReceived = rows.reduce((sum, row) => sum + row.received, 0);
    return { totalSent, totalReceived };
  }, [rows]);
  const replyUnit = language === "ru"
    ? russianPlural(stats.totalReceived, "ответ", "ответа", "ответов")
    : t("replies");
  const probeUnit = language === "ru"
    ? russianPlural(stats.totalSent, "проба", "пробы", "проб")
    : t("probes");

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-center">
          <div className="target-field-wrap header-target-field-wrap">
            <label className="field-label header-target-label" htmlFor="target">{t("target")}</label>
            <div className="target-field">
              <Network size={17} className="target-icon" />
              <input
                ref={hostInputRef}
                id="target"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !isActive) void start(); }}
                onFocus={() => setHistoryOpen(true)}
                onBlur={() => {
                  setHost((value) => normalizeTargetInput(value));
                  window.setTimeout(() => setHistoryOpen(false), 120);
                }}
                placeholder={t("domainOrIp")}
                autoComplete="off"
                spellCheck={false}
                disabled={isActive}
                aria-label={t("hostNameOrIp")}
                aria-autocomplete="list"
              />
              {host && !isActive && <button type="button" className="clear-input" aria-label={t("clearHost")} onClick={() => setHost("")}><X size={14} /></button>}
            </div>
            {historyOpen && !isActive && visibleHistory.length > 0 && (
              <div className="target-history" role="listbox" aria-label={t("recentSearches")}>
                <div className="target-history-heading">
                  <span><History size={13} />{t("recentSearches")}</span>
                  <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={clearHistory}>{t("clearHistory")}</button>
                </div>
                {visibleHistory.map((target) => (
                  <div className="target-history-row" key={target}>
                    <button
                      type="button"
                      className="target-history-item"
                      role="option"
                      aria-selected="false"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => { setHost(target); setHistoryOpen(false); hostInputRef.current?.focus(); }}
                    >
                      <Clock3 size={14} /><span>{target}</span>
                    </button>
                    <button
                      type="button"
                      className="target-history-remove"
                      aria-label={`${t("removeHistoryItem")}: ${target}`}
                      title={t("removeHistoryItem")}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => removeHistoryItem(target)}
                    ><X size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {!isActive ? (
            <button className="primary-button" type="button" onClick={() => void start()} disabled={!host.trim()}>
              <Play size={15} fill="currentColor" /> {t("start")}
            </button>
          ) : (
            <button className="stop-button" type="button" onClick={() => void stop()} disabled={status === "stopping"}>
              <Square size={13} fill="currentColor" /> {t("stop")}
            </button>
          )}
          {!isIdleView && visibleStatus && <span className="status-copy" title={displayMessage(statusMessage)}>{visibleStatus}</span>}
        </div>

        <div className="toolbar-actions">
          <div className="export-menu">
            <button className="icon-button" type="button" title={t("exportResults")} aria-label={t("exportResults")} disabled={rows.length === 0}>
              <ArrowDownToLine size={17} />
            </button>
            <div className="export-popover">
              <button type="button" onClick={exportText}>{t("exportText")} <span>.txt</span></button>
            </div>
          </div>
          <button className="icon-button" type="button" title={t("settings")} aria-label={t("settings")} onClick={() => setSettingsOpen(true)}><Settings size={17} /></button>
        </div>
      </header>

      <section className="route-panel" aria-label={t("routeStatistics")}>
        <div className="table-heading">
          <div>
            <h1>{t("routeOverview")}</h1>
            <p>{resolvedIp ? t("livePathTo", {host: host || resolvedIp}) : t("startTracePrompt")}</p>
          </div>
          <div className="table-meta">
            {rows.length > 0 && <span className="sample-count">{stats.totalReceived.toLocaleString(language === "ru" ? "ru-RU" : "en-US")} {replyUnit} / {stats.totalSent.toLocaleString(language === "ru" ? "ru-RU" : "en-US")} {probeUnit}</span>}
            {status === "running" && <span className="monitoring-badge"><span className="live-dot" />{t("live")}</span>}
          </div>
        </div>

        <div className="table-scroll">
          <table className="route-table" aria-label={t("routeOverview")}>
            <thead>
              <tr>
                <th scope="col" className="col-hop">{t("hop")}</th>
                <th scope="col" className="col-host">{t("host")}</th>
                <th scope="col" className="col-ip">{t("ipAddress")}</th>
                <th scope="col" className="numeric col-loss">{t("loss")}</th>
                <th scope="col" className="numeric col-count">{t("sent")}</th>
                <th scope="col" className="numeric col-count">{t("received")}</th>
                <th scope="col" className="numeric col-rtt">{t("best")}</th>
                <th scope="col" className="numeric col-rtt">{t("average")}</th>
                <th scope="col" className="numeric col-rtt">{t("worst")}</th>
                <th scope="col" className="numeric col-rtt">{t("last")}</th>
                <th scope="col" className="numeric col-rtt">{t("jitter")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.hop}-${row.ip}`} className={row.status === "destination" ? "destination-row" : ""}>
                  <td className="hop-number col-hop">{String(row.hop).padStart(2, "0")}</td>
                  <td className="host-cell col-host" title={row.host}>{row.host === "*" ? <span className="muted-star">*</span> : row.host}</td>
                  <td className="ip-cell col-ip">
                    {row.ip === "*" ? <span className="muted-star">—</span> : <button type="button" className="ip-copy" onClick={() => void copyIp(row.ip)} title={t("copyIp")}><span>{row.ip}</span><Copy size={12} /></button>}
                  </td>
                  <td className={`numeric col-loss loss-cell ${row.lossPercent >= 50 ? "loss-high" : row.lossPercent > 0 ? "loss-medium" : "loss-none"}`}>{formatLoss(row.lossPercent)}</td>
                  <td className="numeric col-count mono-cell">{row.sent}</td>
                  <td className="numeric col-count mono-cell">{row.received}</td>
                  <td className="numeric col-rtt mono-cell">{formatMs(row.bestMs)}</td>
                  <td className="numeric col-rtt mono-cell average-cell">{formatMs(row.averageMs)}</td>
                  <td className="numeric col-rtt mono-cell">{formatMs(row.worstMs)}</td>
                  <td className={`numeric col-rtt mono-cell ${row.lastMs !== null ? "last-cell" : "muted-cell"}`}>{formatMs(row.lastMs)}</td>
                  <td className="numeric col-rtt mono-cell">{formatMs(row.jitterMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="empty-state">
              <h2>{status === "error" ? t("traceCouldNotStart") : isActive ? t("discoveringRoute") : t("noRouteData")}</h2>
              <p>{status === "error" ? displayMessage(statusMessage) : isActive ? t("discoveringDescription") : t("emptyDescription")}</p>
              {!isActive && status !== "error" && <button type="button" className="text-action" onClick={() => hostInputRef.current?.focus()}>{t("enterTarget")} <span>↗</span></button>}
              {isActive && <div className="empty-progress"><span /><span /><span /></div>}
            </div>
          )}
        </div>
      </section>

      <footer className="app-footer">
        <div className="footer-left"><span className="footer-brand">LanPinger</span><span>v{appVersion}</span><span className="footer-separator" /><span>{t("localDiagnostics")}</span></div>
        <div className="footer-right">
          {update && <button type="button" className="footer-link footer-update-link" onClick={() => setSettingsOpen(true)}>{t("updateAvailable", {version: `v${update.version}`})}</button>}
          <span className="footer-privacy"><ShieldCheck size={14} /> {t("noTelemetry")}</span>
        </div>
      </footer>

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="modal-heading">
              <div className="modal-icon"><Settings size={18} /></div>
              <div><h2 id="settings-title">{t("preferences")}</h2><p>{t("preferencesDescription")}</p></div>
              <button type="button" className="modal-close" aria-label={t("closeSettings")} onClick={() => setSettingsOpen(false)}><X size={17} /></button>
            </div>
            <div className="setting-row">
              <div><strong>{t("textSaveFolder")}</strong><span>{t("textSaveFolderDescription")}</span></div>
              <input className="text-path-input" aria-label={t("textSaveFolder")} placeholder={t("textSaveFolderPlaceholder")} value={textSaveFolder} onChange={(event) => { setTextSaveFolder(event.target.value); localStorage.setItem("lanpinger.text-save-folder", event.target.value); }} />
            </div>
            <div className="setting-row">
              <div><strong>{t("traceIntervalTitle")}</strong><span>{t("intervalSettingDescription")}</span></div>
              <SettingSelect
                ariaLabel={t("traceIntervalTitle")}
                value={intervalMs}
                disabled={isActive}
                onChange={(value) => setIntervalMs(Number(value))}
                options={INTERVALS.map((value) => ({value, label: formatInterval(value, language)}))}
              />
            </div>
            <div className="setting-row">
              <div><strong>{t("appearance")}</strong><span>{t("appearanceDescription")}</span></div>
              <div className="theme-switcher">
                <button type="button" className={theme === "dark" ? "selected" : ""} onClick={() => setTheme("dark")}><Moon size={14} /> {t("dark")}</button>
                <button type="button" className={theme === "light" ? "selected" : ""} onClick={() => setTheme("light")}><Sun size={14} /> {t("light")}</button>
              </div>
            </div>
            <div className="setting-row">
              <div><strong>{t("language")}</strong><span>{t("languageDescription")}</span></div>
              <SettingSelect
                className="language-select"
                ariaLabel={t("language")}
                value={languagePreference}
                onChange={(value) => setLanguagePreference(value as LanguagePreference)}
                options={[
                  {value: "system", label: t("systemLanguage", {language: language === "ru" ? t("russian") : t("english")})},
                  {value: "ru", label: t("russian")},
                  {value: "en", label: t("english")},
                ]}
              />
            </div>
            <section className="settings-update-section" aria-label={t("aboutUpdates")}>
              <div className="settings-update-row">
                <div className="settings-update-copy">
                  <div className="settings-update-title"><strong>LanPinger</strong><span>v{appVersion}</span></div>
                  <span className={`settings-update-status${update ? " is-available" : ""}`}>
                    {update ? t("versionAvailable", {version: update.version}) : displayMessage(updateState)}
                  </span>
                  {update && <span className="settings-update-details">{update.body || t("signedUpdateReady")}</span>}
                </div>
                <div className="settings-update-actions">
                  <button type="button" className={update ? "primary-button" : "secondary-button"} onClick={() => update ? void installUpdate() : void checkForUpdates()} disabled={checkingUpdate || installingUpdate}>
                    {update ? <Download size={14} /> : <RefreshCw size={14} className={checkingUpdate ? "spin" : ""} />}
                    {update ? (installingUpdate ? t("downloadingUpdate") : t("installRestart")) : (checkingUpdate ? t("checking") : t("checkAgain"))}
                  </button>
                </div>
              </div>
              {updateProgress !== null && (
                <div className="download-progress">
                  <div><span>{t("downloadingUpdate")}</span><span>{updateLength ? `${Math.min(100, Math.round(updateProgress / updateLength * 100))}%` : `${Math.round(updateProgress / 1_000_000)} MB`}</span></div>
                  <div className="progress-track"><span style={{ width: `${updateLength ? Math.min(100, updateProgress / updateLength * 100) : 0}%` }} /></div>
                </div>
              )}
            </section>
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status"><CheckCircle2 size={15} />{displayMessage(toast)}</div>}
    </main>
  );
}

export default App;
