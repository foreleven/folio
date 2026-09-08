export const integrationMessages = {
  en: {
    title: 'Integrations', subtitle: 'Connect the places where your knowledge begins.',
    available: 'Available integrations', intro: 'Bring conversations and email into your personal wiki.',
    description: 'Connect Lark to make your conversations and email available to Folio.',
    im: 'Messages', email: 'Email', install: 'Install Lark', check: 'Check status',
    open: 'Open authorization page', waiting: 'Finish authorization in your browser. This page will update automatically.',
    installHint: 'Installs missing Lark CLI and skills. You’ll authorize access in the next steps.',
    readyHint: 'Lark is connected. Messages and email are available as resources.',
    scope: 'Installed on this device', loading: 'Loading integrations…',
    failed: 'Couldn’t complete the operation. Check the connection and try again.',
    loadFailed: 'Couldn’t load integrations.', retry: 'Try again', unknown: 'Needs attention',
    tools: 'Tools', app: 'Application', account: 'Your account',
    checking: 'Checking…', working: 'Working…',
    actions: { create_app: 'Create Lark app', verify_app: 'Verify application', refresh_auth: 'Refresh authorization', authorize: 'Authorize Lark', install: 'Install tools' },
    states: {
      not_installed: 'Not installed', install_required: 'Setup required', installing: 'Installing tools',
      app_required: 'Create an application', creating_app: 'Preparing application', waiting_for_app: 'Awaiting application approval',
      app_authorization_required: 'Verify application', verifying_app: 'Verifying application',
      login_required: 'Authorization required', authorizing: 'Preparing authorization', waiting_for_user: 'Awaiting your authorization',
      refreshing_auth: 'Refreshing authorization', ready: 'Connected', cancelled: 'Cancelled', action_failed: 'Needs attention', check_failed: 'Check failed'
    }
  },
  'zh-CN': {
    title: '集成', subtitle: '连接知识产生的地方。', available: '可用集成', intro: '将会话和邮件接入你的个人 Wiki。',
    description: '连接 Lark，让 Folio 可以访问你的会话和邮件。', im: '即时通讯', email: '邮箱',
    install: '安装 Lark', check: '检查状态', open: '打开授权页面',
    waiting: '请在浏览器中完成授权，此页面会自动更新。',
    installHint: '安装缺失的 Lark CLI 和 skills，随后由你授权数据访问。',
    readyHint: 'Lark 已连接，即时通讯与邮箱已注册为可用资源。',
    scope: '安装在此设备上', loading: '正在读取集成…',
    failed: '操作未能完成，请检查网络连接后重试。', loadFailed: '无法读取集成。', retry: '重试', unknown: '需要处理',
    tools: '工具', app: '应用', account: '用户授权', checking: '正在检查…', working: '正在处理…',
    actions: { create_app: '创建 Lark 应用', verify_app: '验证应用授权', refresh_auth: '刷新用户授权', authorize: '授权访问 Lark', install: '安装工具' },
    states: {
      not_installed: '尚未安装', install_required: '需要安装工具', installing: '正在安装工具',
      app_required: '需要创建应用', creating_app: '正在准备应用', waiting_for_app: '等待应用授权',
      app_authorization_required: '需要验证应用', verifying_app: '正在验证应用',
      login_required: '需要用户授权', authorizing: '正在准备授权', waiting_for_user: '等待用户授权',
      refreshing_auth: '正在刷新授权', ready: '已连接', cancelled: '已取消', action_failed: '需要处理', check_failed: '检查失败'
    }
  }
}
