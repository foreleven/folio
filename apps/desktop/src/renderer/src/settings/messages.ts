/** Shared labels for settings navigation and preference forms in each supported locale. */
export const settingsMessages = {
  en: {
    title: 'Settings', subtitle: 'Make Folio feel like home.', general: 'General', integrations: 'Integrations', agent: 'Agent', models: 'Models',
    theme: 'Appearance', themeDescription: 'Choose how Folio looks on this device.',
    language: 'Language', languageDescription: 'Choose the language used in Folio.',
    system: 'System', light: 'Light', dark: 'Dark',
    loading: 'Loading preferences…', retry: 'Try again',
    loadError: 'Couldn’t load preferences', loadDetail: 'Check your configuration file and try again.',
    saveError: 'Couldn’t save changes', saveDetail: 'Your previous preferences are still active. Please try again.'
  },
  'zh-CN': {
    title: '设置', subtitle: '让 Folio 更合你的习惯。', general: '通用', integrations: '集成', agent: 'Agent', models: '模型',
    theme: '外观', themeDescription: '选择 Folio 在这台设备上的显示主题。',
    language: '语言', languageDescription: '选择 Folio 界面使用的语言。',
    system: '跟随系统', light: '浅色', dark: '深色',
    loading: '正在读取配置…', retry: '重试',
    loadError: '无法读取配置', loadDetail: '请检查配置文件后重试。',
    saveError: '无法保存更改', saveDetail: '之前的配置仍然有效，请重试。'
  }
}
