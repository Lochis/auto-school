import SettingsPanel from "../settings-panel";
import ModelQuotas from "./model-quotas";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <main>
      <h1>Settings</h1>
      <SettingsPanel />
      <ModelQuotas />
    </main>
  );
}
