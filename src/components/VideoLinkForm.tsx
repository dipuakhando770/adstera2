import type { LinkRecord } from '../shared/types';
import { LinkForm } from './LinkForm';

interface VideoLinkFormProps {
  editingLink?: LinkRecord | null;
  onSuccess?: (link: LinkRecord) => void;
  onCancelEdit?: () => void;
}

export function VideoLinkForm({
  editingLink = null,
  onSuccess,
  onCancelEdit,
}: VideoLinkFormProps) {
  return (
    <LinkForm
      defaultLinkType="video"
      editingLink={editingLink}
      onSuccess={onSuccess}
      onCancelEdit={onCancelEdit}
    />
  );
}
