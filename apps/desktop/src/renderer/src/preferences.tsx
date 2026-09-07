import { useAtomValue } from '@effect/atom-react'
import { createContext, useContext, useEffect, useLayoutEffect, useState } from 'react'
import type { GlobalConfig } from '../../shared/config'
import { configAtom } from './rpc/config-rpc'

type Locale = 'en' | 'zh-CN'
const LocaleContext = createContext<Locale>('en')

/** Resolves supported interface languages, falling back to English for other OS locales. */
export function resolveLocale(language: GlobalConfig['language'], systemLanguage: string): Locale {
  return language === 'system'
    ? (/^zh(?:-|$)/i.test(systemLanguage) ? 'zh-CN' : 'en')
    : language
}

/** Returns the locale resolved by the window's preference subscription. */
export function useLocale(): Locale {
  return useContext(LocaleContext)
}

/** Applies persisted preferences in each window and follows OS changes in system mode. */
export function PreferencesProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const config = useAtomValue(configAtom)
  const [systemLanguage, setSystemLanguage] = useState(() => navigator.language)
  const theme = config._tag === 'Success' ? config.value.theme : 'system'
  const language = config._tag === 'Success' ? config.value.language : 'system'
  const locale = resolveLocale(language, systemLanguage)

  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    /** Keeps CSS tokens and native controls on the same resolved color scheme. */
    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    const onLanguageChange = (): void => setSystemLanguage(navigator.language)
    window.addEventListener('languagechange', onLanguageChange)
    return () => window.removeEventListener('languagechange', onLanguageChange)
  }, [])

  useEffect(() => { document.documentElement.lang = locale }, [locale])

  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
}
