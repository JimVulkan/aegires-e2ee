// Settings screen. Built from plain React Native primitives (View/Text/TextInput/Switch/...)
// instead of Discord's own form components, because those get renamed/removed between
// Discord versions while React Native's primitives do not. Colors assume Discord's dark theme.
import { React, RN, comp, reactDiagnostics } from "../rt.ts";
import { selectedChannelId } from "../patch.ts";
import { storage } from "@vendetta/plugin";
import { notify as showToast } from "../notify.ts";
import {
  clearGlobalKey,
  hasGlobalKey,
  listChannelConfigs,
  removeChannelConfig,
  setChannelEnabled,
  setChannelPassword,
  setGlobalPassword,
} from "../state.ts";
import { runSelfTest } from "../selftest.ts";
import { diagLines } from "../diag.ts";

const View = comp("View");
const Text = comp("Text");
const ScrollView = comp("ScrollView") ?? View;
const TextInput = comp("TextInput") ?? Text;
const Touch = comp("TouchableOpacity") ?? comp("Pressable") ?? comp("TouchableWithoutFeedback") ?? View;

// Simple replacement if this Discord build has no Switch export.
function FallbackSwitch(props: { value: boolean; onValueChange: (v: boolean) => void }) {
  return (
    <Touch onPress={() => props.onValueChange(!props.value)}>
      <View style={{ backgroundColor: props.value ? C.accent : C.input, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14 }}>
        <Text style={{ color: "#fff", fontWeight: "700" }}>{props.value ? "ON" : "OFF"}</Text>
      </View>
    </Touch>
  );
}
const Switch = comp("Switch") ?? FallbackSwitch;

const C = { text: "#dbdee1", muted: "#949ba4", card: "#2b2d31", input: "#1e1f22", accent: "#5865f2", danger: "#da373c" };

function Button(props: { label: string; onPress: () => void; danger?: boolean; busy?: boolean }) {
  return (
    <Touch
      disabled={props.busy}
      onPress={props.onPress}
      style={{ backgroundColor: props.danger ? C.danger : C.accent, opacity: props.busy ? 0.5 : 1, padding: 10, borderRadius: 6, marginTop: 8 }}
    >
      <Text style={{ color: "#fff", textAlign: "center", fontWeight: "600" }}>{props.label}</Text>
    </Touch>
  );
}

function Field(props: { value: string; onChange: (v: string) => void; placeholder: string; secret?: boolean }) {
  return (
    <TextInput
      value={props.value}
      onChangeText={props.onChange}
      placeholder={props.placeholder}
      placeholderTextColor={C.muted}
      secureTextEntry={!!props.secret}
      autoCapitalize="none"
      autoCorrect={false}
      style={{ backgroundColor: C.input, color: C.text, borderRadius: 6, padding: 10, marginTop: 8 }}
    />
  );
}

function Card(props: { title: string; children?: any; hint?: string }) {
  return (
    <View style={{ backgroundColor: C.card, borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <Text style={{ color: C.text, fontSize: 16, fontWeight: "700" }}>{props.title}</Text>
      {props.hint ? <Text style={{ color: C.muted, marginTop: 4 }}>{props.hint}</Text> : null}
      {props.children}
    </View>
  );
}

function ToggleRow(props: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
      <Text style={{ color: C.text, flex: 1, paddingRight: 12 }}>{props.label}</Text>
      <Switch value={props.value} onValueChange={props.onChange} />
    </View>
  );
}

function currentChannelId(): string {
  try {
    return selectedChannelId();
  } catch {
    return "";
  }
}

function SettingsInner() {
  const [, bump] = React.useState(0); // manual re-render (no dependency on useProxy)
  const refresh = () => bump((n: number) => n + 1);
  const [pw, setPw] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [chanId, setChanId] = React.useState(currentChannelId());
  const [chanPw, setChanPw] = React.useState("");
  const [testLines, setTestLines] = React.useState([] as string[]);

  // Run a slow async action with a busy flag, and report failures instead of crashing.
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      showToast(what + " - done");
    } catch (e) {
      showToast(what + " failed: " + String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
      <Card
        title={"Global key " + (hasGlobalKey() ? "(set)" : "(not set)")}
        hint="Used in every chat that has no channel key. Everyone in the chat must type the SAME password, and Aegires users must use the same one in the app. The password is not saved - only the key derived from it."
      >
        <Field value={pw} onChange={setPw} placeholder="Shared password" secret />
        <Button
          label={busy ? "Deriving key..." : "Set global key"}
          busy={busy}
          onPress={() => {
            if (!pw) return showToast("Password cannot be empty");
            run("Set global key", async () => {
              await setGlobalPassword(pw);
              setPw("");
            });
          }}
        />
        {hasGlobalKey() ? <Button label="Clear global key" danger onPress={() => { clearGlobalKey(); showToast("Global key cleared"); refresh(); }} /> : null}
      </Card>

      <Card title="Behaviour">
        <ToggleRow label="Encrypt outgoing messages by default (in chats without their own on/off setting)" value={!!storage.encryptByDefault} onChange={(v) => { storage.encryptByDefault = v; refresh(); }} />
        <ToggleRow label="Show a lock icon in front of decrypted messages" value={!!storage.showLock} onChange={(v) => { storage.showLock = v; refresh(); }} />
        <ToggleRow label="Debug logging" value={!!storage.debug} onChange={(v) => { storage.debug = v; refresh(); }} />
      </Card>

      <Card title="Per-chat key / switch" hint="Channel ID is pre-filled with the chat you had open. Leave the password empty to only change on/off.">
        <Field value={chanId} onChange={setChanId} placeholder="Channel ID" />
        <Field value={chanPw} onChange={setChanPw} placeholder="Password for this chat only (optional)" secret />
        <Button
          label="Save for this chat"
          busy={busy}
          onPress={() => {
            if (!/^\d+$/.test(chanId)) return showToast("Channel ID must be digits only");
            run("Save chat settings", async () => {
              if (chanPw) await setChannelPassword(chanId, chanPw);
              setChannelEnabled(chanId, true);
              setChanPw("");
            });
          }}
        />
        {listChannelConfigs().map((c) => (
          <View key={c.id} style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: C.input, paddingTop: 8 }}>
            <Text style={{ color: C.text }}>{c.id}{c.hasKey ? "  (own key)" : ""}</Text>
            <ToggleRow label="Encrypt outgoing here" value={c.enabled === true} onChange={(v) => { setChannelEnabled(c.id, v); refresh(); }} />
            <Button label="Remove" danger onPress={() => { removeChannelConfig(c.id); refresh(); }} />
          </View>
        ))}
      </Card>

      <Card title="Diagnostics" hint="What the hooks are doing right now. Press Refresh after sending / receiving a message.">
        <Button label="Refresh" onPress={() => refresh()} />
        <Text selectable style={{ color: C.text, marginTop: 8, fontFamily: "monospace", fontSize: 12 }}>
          {"global key: " + (hasGlobalKey() ? "set" : "NOT SET") + "\n" + diagLines().join("\n")}
        </Text>
      </Card>

      <Card title="Self-test" hint="Run this first. It checks Discord has a secure random source and that this phone can decrypt messages made by the real Aegires code.">
        <Button
          label={busy ? "Running..." : "Run self-test"}
          busy={busy}
          onPress={() =>
            run("Self-test", async () => {
              const r = await runSelfTest();
              setTestLines(r.lines);
              showToast(r.ok ? "Self-test passed" : "Self-test FAILED");
            })
          }
        />
        {testLines.map((l: string, i: number) => (
          <Text key={i} style={{ color: l.startsWith("PASS") ? C.text : C.danger, marginTop: 4, fontFamily: "monospace" }}>{l}</Text>
        ))}
      </Card>
    </ScrollView>
  );
}

// If anything in the screen throws, show the error text on screen instead of Discord's
// "Uh Oh" crash page, so we can see what broke.
export default function Settings() {
  try {
    return SettingsInner();
  } catch (e: any) {
    const msg = String(e) + "\n" + String(e?.stack ?? "").slice(0, 1200) + "\n" + reactDiagnostics();
    console.log("[aegires-e2ee] settings crashed", msg);
    try {
      RN.Alert.alert("Aegires settings crashed", msg);
    } catch {}
    try {
      return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
          <Text selectable style={{ color: C.danger }}>{msg}</Text>
        </ScrollView>
      );
    } catch {
      return null;
    }
  }
}
