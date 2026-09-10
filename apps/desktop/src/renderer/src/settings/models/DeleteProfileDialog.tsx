import type { ModelProfile } from '@folio/agent/config/schema'
import { Button } from '@folio/ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@folio/ui/components/ui/dialog'
import { modelSettingsMessages, type ModelSettingsLocale } from './messages'

type Props = {
  profile: ModelProfile | null
  locale: ModelSettingsLocale
  pending: boolean
  onClose: () => void
  onConfirm: (profileId: string) => void
}

/** Requires an explicit confirmation before deleting a non-default profile. */
export function DeleteProfileDialog({ profile, locale, pending, onClose, onConfirm }: Props): React.JSX.Element {
  const text = modelSettingsMessages[locale]
  return (
    <Dialog open={profile !== null} onOpenChange={(open) => { if (!open && !pending) onClose() }}>
      {profile === null ? null : (
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{text.deleteTitle}</DialogTitle>
            <DialogDescription>{text.deleteDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={onClose}>{text.cancel}</Button>
            <Button variant="destructive" disabled={pending} onClick={() => onConfirm(profile.id)}>
              {pending ? text.deletingProfile : text.confirmDelete}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
