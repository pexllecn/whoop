import { SettingsForm } from '@/components/settings-form';
import { PageHeader } from '@/components/ui';
import { protocolMapPath } from '@/lib/daemon/protocolMap';
import { getDb } from '@/lib/storage/db';
import { getSettings, publicSettings } from '@/lib/storage/settings';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  const settings = publicSettings(getSettings(getDb()));
  return (
    <>
      <PageHeader title="Settings" subtitle="Stored in the local SQLite database" />
      <SettingsForm initial={settings} protocolMapPath={protocolMapPath()} />
    </>
  );
}
