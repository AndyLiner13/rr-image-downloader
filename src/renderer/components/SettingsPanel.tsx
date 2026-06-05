import { Settings as SettingsIcon } from 'lucide-react';
import React from 'react';
import { computeMaxConcurrencyForDelay } from '../../shared/concurrency';
import { RecNetSettings } from '../../shared/types';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { OutputPathPickerGroup } from './OutputPathPickerGroup';

interface SettingsPanelProps {
  settings: RecNetSettings;
  onUpdateSettings: (settings: Partial<RecNetSettings>) => Promise<void>;
  onLog: (
    message: string,
    type?: 'info' | 'success' | 'error' | 'warning'
  ) => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  settings,
  onUpdateSettings,
  onLog,
}) => {
  // The concurrency limit is a separate setting from the request delay, but its
  // allowed maximum is derived from the delay. A faster delay permits more
  // concurrent downloads; a slower delay lowers the ceiling.
  const dynamicMaxConcurrency = computeMaxConcurrencyForDelay(
    settings.interPageDelayMs ?? 0
  );

  const handleDelayChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.trim();
    const nextDelay = value === '' ? 100 : parseInt(value);
    if (isNaN(nextDelay)) {
      return;
    }
    const clampedDelay = Math.min(1000, Math.max(0, nextDelay));
    // Re-clamp the concurrency limit to the new delay's dynamic maximum so it
    // never exceeds the bound after the delay changes.
    const nextMaxConcurrency = computeMaxConcurrencyForDelay(clampedDelay);
    const updates: Partial<RecNetSettings> = { interPageDelayMs: clampedDelay };
    if (settings.maxConcurrentDownloads > nextMaxConcurrency) {
      updates.maxConcurrentDownloads = nextMaxConcurrency;
    }
    await onUpdateSettings(updates);
  };

  const handleMaxConcurrentChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const value = e.target.value.trim();
    if (value === '') {
      await onUpdateSettings({
        maxConcurrentDownloads: Math.min(3, dynamicMaxConcurrency),
      });
    } else {
      const numValue = parseInt(value);
      if (!isNaN(numValue)) {
        const clampedValue = Math.min(
          dynamicMaxConcurrency,
          Math.max(1, numValue)
        );
        await onUpdateSettings({ maxConcurrentDownloads: clampedValue });
      }
    }
  };

  const handleMaxPhotosChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const value = e.target.value.trim();
    if (value === '') {
      await onUpdateSettings({ maxPhotosToDownload: undefined });
    } else {
      const numValue = parseInt(value);
      if (!isNaN(numValue) && numValue > 0) {
        await onUpdateSettings({ maxPhotosToDownload: numValue });
      }
    }
  };

  const handleBackgroundMetadataSyncChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    await onUpdateSettings({
      backgroundMetadataSyncEnabled: e.target.checked,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SettingsIcon className="h-5 w-5" />
          Settings
        </CardTitle>
        <CardDescription>
          Configure output path and download behavior
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <OutputPathPickerGroup
          settings={settings}
          onUpdateSettings={onUpdateSettings}
          heading="Output Path"
          inputId="output-path"
          showConfigurationCallout
          calloutContext="settings"
          onPickerError={msg => onLog(msg, 'error')}
          onFolderChosen={path =>
            onLog(`Output folder set to: ${path}`, 'info')
          }
        />

        <div className="space-y-2">
          <div className="flex items-start gap-3 rounded-md border p-3">
            <input
              id="background-metadata-sync"
              type="checkbox"
              checked={settings.backgroundMetadataSyncEnabled}
              onChange={handleBackgroundMetadataSyncChange}
              className="mt-1 h-4 w-4 rounded border-input text-primary focus:ring-2 focus:ring-ring"
            />
            <div className="space-y-1">
              <Label htmlFor="background-metadata-sync">
                Background metadata image sync
              </Label>
              <p className="text-sm text-muted-foreground">
                Automatically downloads missing profile, event cover, and room
                listing images after launch, downloads, and library folder
                changes.
              </p>
            </div>
          </div>
        </div>

        {/* Delay Between Pages */}
        <div className="space-y-2">
          <Label htmlFor="request-delay">Request Delay (ms)</Label>
          <p className="text-xs text-muted-foreground">
            Resets to 100 when the app is closed and reopened.
          </p>
          <Input
            id="request-delay"
            type="number"
            value={settings.interPageDelayMs ?? 0}
            onChange={handleDelayChange}
            min="0"
            max="1000"
          />
          <p className="text-sm text-muted-foreground">
            Milliseconds between requests. Set to 0 for unlimited download
            speed.
          </p>
        </div>

        {/* Concurrent Downloads */}
        <div className="space-y-2">
          <Label htmlFor="concurrent-downloads">Max Concurrent Downloads</Label>
          <p className="text-xs text-muted-foreground">
            Resets to 3 when the app is closed and reopened.
          </p>
          <Input
            id="concurrent-downloads"
            type="number"
            value={settings.maxConcurrentDownloads}
            onChange={handleMaxConcurrentChange}
            min="1"
            max={dynamicMaxConcurrency}
          />
          <p className="text-sm text-muted-foreground">
            Amount of images that can be downloaded concurrently. The maximum is
            tied to the request delay above &mdash; at the current delay of{' '}
            {settings.interPageDelayMs ?? 0}ms the limit is{' '}
            {dynamicMaxConcurrency}. Lower this value if your downloads are
            consistently failing.
          </p>
        </div>

        {/* Max Photos to Download (Testing) */}
        <div className="space-y-2">
          <Label htmlFor="max-photos">Max Photos to Download (Testing)</Label>
          <Input
            id="max-photos"
            type="number"
            value={settings.maxPhotosToDownload || ''}
            onChange={handleMaxPhotosChange}
            min="1"
            placeholder="No limit"
          />
          <p className="text-sm text-muted-foreground">
            Limit the number of new photos to download for testing. Leave empty
            for no limit.
          </p>
        </div>
      </CardContent>
    </Card>
  );
};
