import type { ModelCatalogEntry } from '../../../../shared/model'
import { modelSettingsMessages, type ModelSettingsLocale } from './messages'

/** Presents catalog data as a read-only list, without requiring model profile configuration. */
export function ProviderModels({ models, locale }: { models: readonly ModelCatalogEntry[]; locale: ModelSettingsLocale }): React.JSX.Element {
  const text = modelSettingsMessages[locale]
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between text-support text-muted-foreground"><span>{text.availableModels}</span><span>{models.length}</span></div>
      <div className="max-h-64 overflow-y-auto rounded-lg border">
        {models.length === 0 ? <p className="p-3 text-support text-muted-foreground">{text.noProviderModels}</p> : (
          <ul className="divide-y" aria-label={text.availableModels}>
            {models.map((model) => <li key={`${model.providerId}/${model.modelId}`} className="px-3 py-2">
              <p className="break-words text-ui">{model.modelName}</p>
              <p className="break-all text-support text-muted-foreground">{model.modelId}</p>
            </li>)}
          </ul>
        )}
      </div>
    </div>
  )
}
