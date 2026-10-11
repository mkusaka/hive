import { defaultSidebarPrefs, type SidebarPrefs } from "@hive/contracts";
import { createSync, type ListKey, type SyncStatus } from "@hive/sync";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { client, inWorkspace, type Client } from "./src/api";
import {
  conversationSections,
  insertMention,
  mentionSuggestions,
  notificationTarget,
  postMessage,
  type Conversation,
  type Row,
  type Screen,
} from "./src/model";
import {
  accessToken,
  clearSession,
  loadSession,
  saveSession,
  signIn,
  type Session,
} from "./src/session";
import { Button, colors, Input, Markdown, styles } from "./src/ui";

const extra = Constants.expoConfig?.extra as { apiUrl?: string; devScheme?: boolean } | undefined;
const tabs = ["channels", "approvals", "activity", "search", "settings"] as const;
const emptyStatus: SyncStatus = { cursor: null, unsynced: 0, error: null };
// React Native supports authenticated headers; lib.dom's constructor omits this native overload.
const NativeWebSocket: new (
  url: string,
  protocols?: string[],
  options?: { headers: Record<string, string> },
) => WebSocket = WebSocket;

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "channels" });
  const [channels, setChannels] = useState<Row[]>([]);
  const [dms, setDms] = useState<Row[]>([]);
  const [bots, setBots] = useState<Row[]>([]);
  const [jobs, setJobs] = useState<Row[]>([]);
  const [approvals, setApprovals] = useState<Row[]>([]);
  const [sidebar, setSidebar] = useState<{ workspaceName: string; prefs: SidebarPrefs }>({
    workspaceName: "hive",
    prefs: defaultSidebarPrefs,
  });
  const [status, setStatus] = useState(emptyStatus);
  const [connection, setConnection] = useState("reconnecting");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pushStatus, setPushStatus] = useState("Not registered");
  const api = useMemo(() => (session ? client(session) : null), [session]);
  const pull = useRef<() => Promise<void>>(async () => {});
  const report = useCallback(
    (error: unknown) => setProblem(error instanceof Error ? error.message : "Request failed"),
    [],
  );
  useEffect(() => {
    void loadSession()
      .then(setSession)
      .catch(report)
      .finally(() => setLoaded(true));
  }, [report]);
  const updateSession = async (next: Session) => {
    await saveSession(next);
    setChannels([]);
    setDms([]);
    setBots([]);
    setJobs([]);
    setApprovals([]);
    setSidebar({ workspaceName: "hive", prefs: defaultSidebarPrefs });
    setStatus(emptyStatus);
    setProblem(null);
    setSession(next);
    setScreen({ kind: "channels" });
  };

  useEffect(() => {
    if (!api || !session?.workspaceId) return;
    let alive = true;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const load = async (keys: Set<ListKey>) => {
      const requests: Promise<void>[] = [];
      const lists = [
        ["channels", "channels", setChannels],
        ["dms", "dms", setDms],
        ["bots", "bots", setBots],
        ["jobs", "jobs", setJobs],
        ["approvals", "approvals", setApprovals],
      ] as const;
      for (const [key, resource, setter] of lists) {
        if (keys.has(key))
          requests.push(
            api
              .request(
                inWorkspace(
                  session.workspaceId,
                  resource,
                  key === "approvals" ? { state: "pending" } : {},
                ),
              )
              .then((value) => {
                if (alive) setter(value[key] as Row[]);
              }),
          );
      }
      if (keys.has("sidebar"))
        requests.push(
          api.request(inWorkspace(session.workspaceId, "sidebar")).then((value) => {
            if (alive) setSidebar(value as { workspaceName: string; prefs: SidebarPrefs });
          }),
        );
      await Promise.all(requests);
      if (alive) setRevision((n) => n + 1);
    };
    const sync = createSync({
      workspaceId: session.workspaceId,
      get: api.get,
      refetch: load,
      onStatus: (value) => {
        if (alive) setStatus(value);
      },
    });
    pull.current = sync.pull;
    const connect = async () => {
      if (!alive || AppState.currentState !== "active" || socket) return;
      try {
        const token = await accessToken(session);
        if (!alive || AppState.currentState !== "active") return;
        const url = new URL(`${session.apiUrl}/v1/realtime`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("workspaceId", session.workspaceId);
        const next = new NativeWebSocket(url.href, undefined, {
          headers: {
            Authorization: `Bearer ${token}`,
            ...(session.devToken ? { "Cf-Access-Jwt-Assertion": token } : {}),
          },
        });
        socket = next;
        next.addEventListener("open", () => {
          if (alive) {
            setConnection("connected");
            void sync.pull();
          }
        });
        next.addEventListener("message", (event) => {
          try {
            const hint = JSON.parse(String(event.data)) as { type?: string };
            if (hint.type === "sync.changed") void sync.hint();
          } catch {
            /* Malformed hints cannot change state. HTTP remains authoritative. */
          }
        });
        next.addEventListener("close", () => {
          if (socket === next) socket = null;
          if (!alive) return;
          setConnection("reconnecting");
          reconnect = setTimeout(() => void connect(), 5000);
        });
        next.addEventListener("error", () => next.close());
      } catch (error) {
        if (alive) {
          report(error);
          reconnect = setTimeout(() => void connect(), 5000);
        }
      }
    };
    void sync.pull();
    void connect();
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void sync.pull();
        void connect();
      } else {
        clearTimeout(reconnect);
        socket?.close();
        socket = null;
      }
    });
    const timer = setInterval(() => {
      if (AppState.currentState !== "active") return;
      void sync.pull();
      // Re-authenticate the socket before the grant expires; HTTP refreshes the stored grant.
      if (session.oauth && session.oauth.expiresAt < Date.now() + 60_000) {
        socket?.close();
        socket = null;
      }
      void connect();
    }, 15_000);
    return () => {
      alive = false;
      pull.current = async () => {};
      foreground.remove();
      clearInterval(timer);
      clearTimeout(reconnect);
      socket?.close();
    };
  }, [api, session, report]);

  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (screen.kind === "channels") return false;
      if (screen.kind === "conversation" && screen.conversation.parent)
        setScreen({ kind: "conversation", conversation: screen.conversation.parent });
      else setScreen({ kind: "channels" });
      return true;
    });
    return () => back.remove();
  }, [screen]);

  useEffect(() => {
    if (!api || !session?.workspaceId) return;
    let alive = true;
    const register = async (token: string) => {
      await api.request("/v1/devices/mobile", "POST", { instanceId: session.instanceId, token });
      if (alive) setPushStatus("Registered with FCM");
    };
    const enable = async () => {
      await Notifications.setNotificationChannelAsync("hive", {
        name: "hive",
        importance: Notifications.AndroidImportance.HIGH,
      });
      const permission = await Notifications.requestPermissionsAsync();
      if (!permission.granted) {
        if (alive) setPushStatus("Notification permission denied");
        return;
      }
      await register(String((await Notifications.getDevicePushTokenAsync()).data));
    };
    void enable().catch(() => {
      if (alive) setPushStatus("FCM unavailable: configure google-services.json and rebuild");
    });
    const rotation = Notifications.addPushTokenListener((token) => {
      void register(String(token.data)).catch(() => {
        if (alive) setPushStatus("Push registration failed");
      });
    });
    const open = async (response: Notifications.NotificationResponse) => {
      const target = notificationTarget(response.notification.request.content.data);
      if (!target) return;
      await pull.current();
      const value = await api.request(
        `/v1/mobile/targets/${target.kind}/${encodeURIComponent(target.id)}`,
      );
      if (!alive) return;
      const workspaceId = String(value.workspaceId);
      if (workspaceId !== session.workspaceId) await updateSession({ ...session, workspaceId });
      if (target.kind === "approval") setScreen({ kind: "approvals" });
      else if (target.kind === "job")
        setScreen({ kind: "detail", resource: "jobs", id: target.id });
      else {
        const kind = value.conversationKind as Conversation["kind"];
        setScreen({
          kind: "conversation",
          conversation: {
            kind,
            id: String(kind === "channel" ? value.channelId : value.conversationId),
            title: String(value.title ?? "Conversation"),
            ...(typeof value.botId === "string" ? { botId: value.botId } : {}),
          },
        });
      }
      Notifications.clearLastNotificationResponse();
    };
    const tap = Notifications.addNotificationResponseReceivedListener((response) => {
      void open(response).catch(report);
    });
    const lastResponse = Notifications.getLastNotificationResponse();
    if (lastResponse) void open(lastResponse).catch(report);
    return () => {
      alive = false;
      rotation.remove();
      tap.remove();
    };
  }, [api, session, report]);

  const act = async (command: Record<string, unknown>) => {
    if (!api) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.command(command);
      await pull.current();
      return result;
    } catch (error) {
      report(error);
      throw error;
    } finally {
      setBusy(false);
    }
  };
  const openDm = async (bot: Row) => {
    try {
      const result = await act({ type: "dm.open", botId: bot.id });
      if (result)
        setScreen({
          kind: "conversation",
          conversation: {
            kind: "dm",
            id: String(result.conversationId),
            title: String(bot.name),
            botId: bot.id,
          },
        });
    } catch {
      /* The command error is already displayed. */
    }
  };
  const signOut = () =>
    Alert.alert(
      "Sign out?",
      "Signing out removes the Access login from this phone. Your Channels and Bots stay; executors on your PCs keep running.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            void (async () => {
              // Revoke this app instance's notification token before dropping credentials.
              try {
                if (api && session)
                  await api.request("/v1/devices/mobile", "DELETE", {
                    instanceId: session.instanceId,
                  });
              } finally {
                await clearSession();
                setSession(null);
                setStatus(emptyStatus);
                setScreen({ kind: "channels" });
                setChannels([]);
                setDms([]);
                setBots([]);
                setJobs([]);
                setApprovals([]);
                setProblem(null);
              }
            })().catch(report);
          },
        },
      ],
    );

  let body;
  if (!loaded) body = <Text style={styles.muted}>Loading…</Text>;
  else if (!session?.workspaceId || !api)
    body = <Welcome session={session} onSession={updateSession} onError={report} />;
  else if (screen.kind === "conversation")
    body = (
      <ConversationScreen
        key={`${session.workspaceId}:${screen.conversation.id}:${screen.conversation.threadOf ?? ""}`}
        conversation={screen.conversation}
        api={api}
        session={session}
        bots={bots}
        revision={revision}
        send={act}
        open={setScreen}
        report={report}
      />
    );
  else if (screen.kind === "detail")
    body = (
      <Detail
        key={`${screen.resource}:${screen.id}`}
        screen={screen}
        api={api}
        revision={revision}
        open={setScreen}
        report={report}
      />
    );
  else if (screen.kind === "search")
    body = (
      <Search
        api={api}
        workspaceId={session.workspaceId}
        channels={channels}
        dms={dms}
        open={setScreen}
        report={report}
      />
    );
  else if (screen.kind === "tasks")
    body = <Tasks api={api} workspaceId={session.workspaceId} open={setScreen} report={report} />;
  else if (screen.kind === "settings")
    body = (
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>Settings</Text>
        <Text style={styles.text}>{session.apiUrl}</Text>
        <Text style={styles.muted}>Workspace: {sidebar.workspaceName}</Text>
        <Text style={styles.muted}>Push: {pushStatus}</Text>
        <Text style={styles.muted}>
          No Agent Runtime runs on Android. Work executes on your PCs.
        </Text>
        <Button
          onPress={() => {
            void updateSession({ ...session, workspaceId: "" }).catch(report);
          }}
        >
          Choose a workspace
        </Button>
        <Button onPress={signOut}>Sign out</Button>
      </ScrollView>
    );
  else
    body = (
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => void pull.current()}
            tintColor={colors.accent}
          />
        }
      >
        <Text style={styles.heading}>
          {screen.kind === "channels"
            ? sidebar.workspaceName
            : screen.kind === "approvals"
              ? "Approvals"
              : "Activity"}
        </Text>
        {screen.kind === "channels" && (
          <>
            {conversationSections(channels, dms, sidebar.prefs, bots).map((section) => (
              <View key={section.title} style={{ gap: 10 }}>
                <Text style={styles.muted}>{section.title}</Text>
                {section.items.map((item) => (
                  <Pressable
                    key={item.key}
                    accessibilityRole="button"
                    style={styles.card}
                    disabled={busy}
                    onPress={() => {
                      const bot = item.key.startsWith("bot:")
                        ? bots.find((row) => row.id === item.conversation.botId)
                        : undefined;
                      if (bot) void openDm(bot);
                      else setScreen({ kind: "conversation", conversation: item.conversation });
                    }}
                  >
                    <Text style={styles.text}>{item.conversation.title}</Text>
                    <Text numberOfLines={2} style={styles.muted}>
                      {item.preview.replace(
                        /<@bot:([^>]+)>/g,
                        (_, id: string) =>
                          `@${String(bots.find((bot) => bot.id === id)?.name ?? id)}`,
                      )}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ))}
          </>
        )}
        {screen.kind === "approvals" && (
          <>
            {approvals.length === 0 && <Text style={styles.muted}>No pending approvals.</Text>}
            {approvals.map((approval) => (
              <View key={approval.id} style={styles.card}>
                <Text style={styles.text}>
                  {String(approval.botName)} · {String(approval.actionKind)}
                </Text>
                <Text selectable style={styles.code}>
                  {String(approval.argsSummary)}
                </Text>
                <Text style={styles.muted}>
                  {String(approval.cwdLabel)} · Expires {String(approval.expiresAt)}
                </Text>
                <View style={styles.row}>
                  {(["allow", "deny"] as const).map((decision) => (
                    <Button
                      key={decision}
                      disabled={busy}
                      onPress={() => {
                        void act({
                          type: "approval.resolve",
                          approvalId: approval.id,
                          decision,
                        }).catch(() => {
                          void pull.current();
                        });
                      }}
                    >
                      {decision === "allow" ? "Allow" : "Deny"}
                    </Button>
                  ))}
                  <Button
                    onPress={() =>
                      setScreen({ kind: "detail", resource: "runs", id: String(approval.runId) })
                    }
                  >
                    Run details
                  </Button>
                </View>
              </View>
            ))}
          </>
        )}
        {screen.kind === "activity" && (
          <>
            <Button onPress={() => setScreen({ kind: "tasks" })}>Tasks</Button>
            {jobs.length === 0 && <Text style={styles.muted}>No jobs yet.</Text>}
            {jobs.map((job) => (
              <View key={job.id} style={styles.card}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setScreen({ kind: "detail", resource: "jobs", id: job.id })}
                >
                  <Text style={styles.text}>
                    {String(bots.find((bot) => bot.id === job.botId)?.name ?? job.botId)} ·{" "}
                    {String(job.state)}
                  </Text>
                  <Text style={styles.muted}>{job.id}</Text>
                </Pressable>
                {job.taskId ? (
                  <Button
                    onPress={() =>
                      setScreen({ kind: "detail", resource: "tasks", id: String(job.taskId) })
                    }
                  >
                    Task details
                  </Button>
                ) : null}
                {!(["succeeded", "failed", "cancelled"] as unknown[]).includes(job.state) && (
                  <Button
                    disabled={busy || !!job.cancelRequestedAt}
                    onPress={() => {
                      void act({ type: "job.cancel", jobId: job.id }).catch(() => {});
                    }}
                  >
                    {job.cancelRequestedAt ? "Cancellation requested" : "Cancel"}
                  </Button>
                )}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    );

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="height">
          {session?.workspaceId && (
            <View style={[styles.row, { paddingHorizontal: 14, paddingVertical: 6 }]}>
              <Button onPress={() => setScreen({ kind: "channels" })}>hive</Button>
              <Text style={styles.muted}>
                {connection} · {status.unsynced} unsynced hints
              </Text>
            </View>
          )}
          {(problem ?? status.error) && (
            <Pressable onPress={() => setProblem(null)} style={{ padding: 12 }}>
              <Text style={styles.error}>{problem ?? status.error}</Text>
              {session && <Button onPress={signOut}>Sign out / sign in again</Button>}
            </Pressable>
          )}
          <View style={{ flex: 1 }}>{body}</View>
          {session?.workspaceId && (
            <View
              style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.border }}
            >
              {tabs.map((tab) => (
                <Pressable
                  key={tab}
                  accessibilityRole="button"
                  onPress={() => setScreen({ kind: tab })}
                  style={{ flex: 1, paddingVertical: 16, alignItems: "center" }}
                >
                  <Text
                    style={{
                      color: screen.kind === tab ? colors.accent : colors.muted,
                      fontSize: 11,
                    }}
                  >
                    {tab === "channels" ? "Chats" : tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Welcome({
  session,
  onSession,
  onError,
}: {
  session: Session | null;
  onSession: (session: Session) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [apiUrl, setApiUrl] = useState(session?.apiUrl ?? extra?.apiUrl ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [name, setName] = useState("");
  const [account, setAccount] = useState(session);
  useEffect(() => {
    if (!account) return;
    let alive = true;
    void client(account)
      .request("/v1/me")
      .then((value) => {
        if (alive) setWorkspaces(value.workspaces as { id: string; name: string }[]);
      })
      .catch(onError);
    return () => {
      alive = false;
    };
  }, [account, onError]);
  const login = async () => {
    setBusy(true);
    try {
      const url = new URL(apiUrl.trim());
      if (url.protocol !== "https:" && !(__DEV__ && url.protocol === "http:"))
        throw new Error("API URL must use HTTPS");
      if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
        throw new Error("Enter an API origin without credentials or a path");
      const next: Session = {
        apiUrl: url.origin,
        workspaceId: "",
        instanceId: session?.instanceId ?? Crypto.randomUUID(),
        ...(__DEV__ && token.trim()
          ? { devToken: token.trim() }
          : { oauth: await signIn(url.origin, __DEV__ && extra?.devScheme === true) }),
      };
      const value = await client(next).request("/v1/me");
      next.userId = String(value.userId);
      await saveSession(next);
      setAccount(next);
      setWorkspaces(value.workspaces as { id: string; name: string }[]);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.content, { flexGrow: 1, justifyContent: "center" }]}
    >
      <Text style={[styles.heading, { fontSize: 48, color: colors.accent }]}>hive</Text>
      <Text style={styles.text}>Your team of always-on Bots, working on your own PCs</Text>
      {!account ? (
        <>
          <Input
            accessibilityLabel="API URL"
            placeholder="https://api.example.com"
            value={apiUrl}
            onChangeText={setApiUrl}
          />
          {__DEV__ && (
            <Input
              accessibilityLabel="HIVE_ACCESS_JWT"
              placeholder="HIVE_ACCESS_JWT (development only)"
              secureTextEntry
              value={token}
              onChangeText={setToken}
            />
          )}
          <Button disabled={busy || !apiUrl.trim()} onPress={() => void login()}>
            {busy ? "Waiting for the browser…" : "Sign in →"}
          </Button>
        </>
      ) : (
        <>
          <Text style={styles.heading}>Choose a workspace</Text>
          {workspaces.map((workspace) => (
            <Button
              key={workspace.id}
              disabled={busy}
              onPress={() => {
                void onSession({ ...account, workspaceId: workspace.id }).catch(onError);
              }}
            >
              {workspace.name}
            </Button>
          ))}
          {workspaces.length === 0 && (
            <>
              <Input
                placeholder="Workspace name"
                accessibilityLabel="Workspace name"
                value={name}
                onChangeText={setName}
              />
              <Button
                disabled={busy || !name.trim()}
                onPress={() => {
                  void (async () => {
                    setBusy(true);
                    try {
                      const workspaceId = `mobile-${Crypto.randomUUID()}`;
                      await client(account).command(
                        { type: "workspace.create", name: name.trim() },
                        workspaceId,
                      );
                      await onSession({ ...account, workspaceId });
                    } finally {
                      setBusy(false);
                    }
                  })().catch(onError);
                }}
              >
                Create →
              </Button>
            </>
          )}
          <Button
            onPress={() => {
              void clearSession().then(() => {
                setAccount(null);
                setWorkspaces([]);
              });
            }}
          >
            Change account or API URL
          </Button>
        </>
      )}
    </ScrollView>
  );
}

function ConversationScreen({
  conversation,
  api,
  session,
  bots,
  revision,
  send,
  open,
  report,
}: {
  conversation: Conversation;
  api: Client;
  session: Session;
  bots: Row[];
  revision: number;
  send: (command: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  open: (screen: Screen) => void;
  report: (error: unknown) => void;
}) {
  const [messages, setMessages] = useState<Row[]>([]);
  const [root, setRoot] = useState<Row | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scroll = useRef<ScrollView>(null);
  useEffect(() => {
    let alive = true;
    const resource =
      conversation.kind === "channel"
        ? `channels/${encodeURIComponent(conversation.id)}/messages`
        : `conversations/${encodeURIComponent(conversation.id)}/messages`;
    void api
      .request(inWorkspace(session.workspaceId, resource, { limit: "100" }))
      .then((value) => {
        if (!alive) return;
        const rows = value.messages as Row[];
        setMessages(conversation.threadOf ? [] : rows.toReversed());
        setRoot(
          conversation.threadOf
            ? (rows.find((row) => row.id === conversation.threadOf) ?? null)
            : ((value.root as Row | null) ?? null),
        );
      })
      .catch(report);
    return () => {
      alive = false;
    };
  }, [api, session.workspaceId, conversation, revision, report]);
  const suggestions = mentionSuggestions(draft, bots, conversation);
  const submit = async () => {
    setSending(true);
    try {
      const result = await send(postMessage(conversation, draft));
      if (result) {
        setDraft("");
        if (conversation.threadOf && result.conversationId)
          open({
            kind: "conversation",
            conversation: {
              ...conversation,
              kind: "thread",
              id: String(result.conversationId),
              threadOf: undefined,
            },
          });
      }
    } catch {
      /* Keep the unsent draft; parent displays the command error. */
    } finally {
      setSending(false);
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <Text style={[styles.heading, { padding: 18 }]}>{conversation.title}</Text>
      <ScrollView
        ref={scroll}
        contentContainerStyle={styles.content}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {root && (
          <View style={styles.card}>
            <Text style={styles.muted}>Thread root</Text>
            <Markdown source={String(root.body)} bots={bots} />
          </View>
        )}
        {messages.map((message) => {
          const thread = message.thread as { conversationId: string; replyCount: number } | null;
          const mine = message.userId === session.userId;
          return (
            <View
              key={message.id}
              style={[styles.bubble, { alignSelf: mine ? "flex-end" : "flex-start" }]}
            >
              <Text style={styles.muted}>
                {mine
                  ? "You"
                  : message.userId
                    ? String(message.userId)
                    : String(
                        bots.find((bot) => bot.actorId === message.actorId)?.name ??
                          message.actorId,
                      )}{" "}
                · {new Date(String(message.createdAt)).toLocaleTimeString()}
              </Text>
              <Markdown source={String(message.body)} bots={bots} />
              {conversation.kind !== "thread" && !conversation.threadOf && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    open({
                      kind: "conversation",
                      conversation: thread
                        ? {
                            kind: "thread",
                            id: thread.conversationId,
                            title: "Thread",
                            parent: conversation,
                            botId: conversation.botId,
                          }
                        : {
                            ...conversation,
                            title: "Thread",
                            threadOf: message.id,
                            parent: conversation,
                          },
                    });
                  }}
                >
                  <Text style={{ color: colors.accent, marginTop: 6 }}>
                    {thread ? `${thread.replyCount} replies` : "Reply in thread"}
                  </Text>
                </Pressable>
              )}
            </View>
          );
        })}
        {messages.length === 0 && <Text style={styles.muted}>No messages yet.</Text>}
      </ScrollView>
      <View style={{ padding: 14, gap: 10 }}>
        {suggestions.length > 0 && (
          <View style={styles.card}>
            {suggestions.map((bot) => (
              <Pressable
                key={bot.id}
                accessibilityRole="button"
                onPress={() => setDraft(insertMention(draft, bot.id))}
              >
                <Text style={styles.text}>@{String(bot.name)}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <Input
          multiline
          accessibilityLabel="Message"
          placeholder={`Message ${conversation.title}`}
          value={draft}
          onChangeText={setDraft}
          style={{ maxHeight: 140 }}
        />
        <Button disabled={sending || !draft.trim()} onPress={() => void submit()}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </View>
    </View>
  );
}

function Detail({
  screen,
  api,
  revision,
  open,
  report,
}: {
  screen: Extract<Screen, { kind: "detail" }>;
  api: Client;
  revision: number;
  open: (screen: Screen) => void;
  report: (error: unknown) => void;
}) {
  const [value, setValue] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let alive = true;
    void api
      .request(`/v1/${screen.resource}/${encodeURIComponent(screen.id)}`)
      .then((result) => {
        if (alive) setValue(result);
      })
      .catch(report);
    return () => {
      alive = false;
    };
  }, [api, screen.resource, screen.id, revision, report]);
  const detail = (value?.run as Record<string, unknown> | undefined) ?? value;
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.heading}>{screen.resource.slice(0, -1)} details</Text>
      <Text style={styles.muted}>{screen.id}</Text>
      {!value && <Text style={styles.muted}>Loading…</Text>}
      {detail &&
        Object.entries(detail).map(([key, field]) => (
          <View key={key} style={styles.card}>
            <Text style={styles.muted}>{key}</Text>
            <Text selectable style={styles.text}>
              {typeof field === "object" ? JSON.stringify(field, null, 2) : String(field ?? "—")}
            </Text>
          </View>
        ))}
      {((value?.runs ?? []) as Row[]).map((run) => (
        <Button key={run.id} onPress={() => open({ kind: "detail", resource: "runs", id: run.id })}>
          Run {run.id}
        </Button>
      ))}
      {((value?.results ?? []) as Row[])
        .filter((result) => result.runId)
        .map((result) => (
          <Button
            key={result.id}
            onPress={() => open({ kind: "detail", resource: "runs", id: String(result.runId) })}
          >
            Result Run {String(result.runId)}
          </Button>
        ))}
    </ScrollView>
  );
}

function Tasks({
  api,
  workspaceId,
  open,
  report,
}: {
  api: Client;
  workspaceId: string;
  open: (screen: Screen) => void;
  report: (error: unknown) => void;
}) {
  const [tasks, setTasks] = useState<Row[]>([]);
  useEffect(() => {
    let alive = true;
    void api
      .request(inWorkspace(workspaceId, "tasks"))
      .then((value) => {
        if (alive) setTasks(value.tasks as Row[]);
      })
      .catch(report);
    return () => {
      alive = false;
    };
  }, [api, workspaceId, report]);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Tasks</Text>
      {tasks.map((task) => (
        <Pressable
          key={task.id}
          style={styles.card}
          accessibilityRole="button"
          onPress={() => open({ kind: "detail", resource: "tasks", id: task.id })}
        >
          <Text style={styles.text}>
            {String(task.key)} · {String(task.title)} · {String(task.status)}
          </Text>
        </Pressable>
      ))}
      {tasks.length === 0 && <Text style={styles.muted}>No tasks yet.</Text>}
    </ScrollView>
  );
}

function Search({
  api,
  workspaceId,
  channels,
  dms,
  open,
  report,
}: {
  api: Client;
  workspaceId: string;
  channels: Row[];
  dms: Row[];
  open: (screen: Screen) => void;
  report: (error: unknown) => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>Search</Text>
      <Input
        accessibilityLabel="Query"
        placeholder="Search"
        value={query}
        onChangeText={setQuery}
      />
      <Button
        disabled={!query.trim()}
        onPress={() => {
          void api
            .request(inWorkspace(workspaceId, "search", { q: query }))
            .then(setResult)
            .catch(report);
        }}
      >
        Search
      </Button>
      {result && <Text style={styles.muted}>Indexed through {String(result.indexedThrough)}</Text>}
      {((result?.hits ?? []) as Record<string, unknown>[]).map((hit) => (
        <Pressable
          key={`${String(hit.sourceKind)}:${String(hit.sourceId)}`}
          style={styles.card}
          accessibilityRole="button"
          onPress={() => {
            if (hit.sourceKind === "task")
              return open({ kind: "detail", resource: "tasks", id: String(hit.sourceId) });
            const id = String(hit.scope).replace(/^channel:/, "");
            const channel = channels.find((row) => row.id === id);
            const dm = dms.find((row) => row.id === id);
            if (channel)
              open({
                kind: "conversation",
                conversation: { kind: "channel", id, title: `#${String(channel.name)}` },
              });
            else if (dm)
              open({
                kind: "conversation",
                conversation: { kind: "dm", id, title: String(dm.name), botId: String(dm.botId) },
              });
          }}
        >
          <Text style={styles.text}>{String(hit.title ?? hit.sourceKind)}</Text>
          <Text style={styles.muted}>{String(hit.snippet)}</Text>
        </Pressable>
      ))}
      {result && (result.hits as unknown[]).length === 0 && (
        <Text style={styles.muted}>No results.</Text>
      )}
    </ScrollView>
  );
}
