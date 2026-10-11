import { parseMarkdown, type Inline } from "@hive/ui-text";
import type { ReactNode } from "react";
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import type { Row } from "./model";

export const colors = {
  background: "#101113",
  panel: "#1d2025",
  border: "#343941",
  text: "#f3f4f6",
  muted: "#9fa6b2",
  accent: "#c8ec98",
  error: "#ffabab",
};
export const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 18, gap: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  text: { color: colors.text, fontSize: 16, lineHeight: 24 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  heading: { color: colors.text, fontSize: 24, fontWeight: "700" },
  card: { padding: 14, borderRadius: 14, backgroundColor: colors.panel, gap: 8 },
  button: {
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.accent,
    alignItems: "center",
  },
  buttonText: { color: colors.background, fontWeight: "600", fontSize: 14 },
  input: {
    color: colors.text,
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    minHeight: 48,
  },
  error: { color: colors.error, fontSize: 14 },
  code: { fontFamily: "monospace", backgroundColor: "#292d34", color: colors.text, fontSize: 14 },
  bubble: { padding: 14, borderRadius: 14, backgroundColor: colors.panel, maxWidth: "95%", gap: 6 },
});

export const Button = ({
  children,
  onPress,
  disabled = false,
}: {
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
}) => (
  <Pressable
    accessibilityRole="button"
    disabled={disabled}
    onPress={onPress}
    style={[styles.button, disabled && { opacity: 0.45 }]}
  >
    <Text style={styles.buttonText}>{children}</Text>
  </Pressable>
);
export const Input = (props: TextInputProps) => (
  <TextInput
    placeholderTextColor={colors.muted}
    autoCapitalize="none"
    {...props}
    style={[styles.input, props.style]}
  />
);
const inline = (parts: Inline[], names: Record<string, string>) =>
  parts.map((part, index) => {
    if (part.kind === "mention")
      return (
        <Text key={index} style={{ color: colors.accent }}>
          @{names[part.id] ?? part.id}
        </Text>
      );
    if (part.kind === "link") {
      const safe = /^https?:\/\//i.test(part.url);
      return (
        <Text
          key={index}
          accessibilityRole={safe ? "link" : undefined}
          style={{ color: safe ? colors.accent : colors.text }}
          onPress={safe ? () => void Linking.openURL(part.url) : undefined}
        >
          {part.text}
        </Text>
      );
    }
    return (
      <Text
        key={index}
        style={
          part.kind === "bold"
            ? { fontWeight: "700" }
            : part.kind === "italic"
              ? { fontStyle: "italic" }
              : part.kind === "code"
                ? styles.code
                : undefined
        }
      >
        {part.text}
      </Text>
    );
  });
export const Markdown = ({ source, bots }: { source: string; bots: Row[] }) => {
  const names = Object.fromEntries(bots.map((bot) => [bot.id, String(bot.name)]));
  return (
    <View style={{ gap: 8 }}>
      {parseMarkdown(source).map((block, index) => {
        if (block.kind === "code")
          return (
            <Text selectable key={index} style={[styles.text, styles.code]}>
              {block.text}
            </Text>
          );
        if (block.kind === "p")
          return (
            <Text selectable key={index} style={styles.text}>
              {inline(block.inlines, names)}
            </Text>
          );
        return (
          <View key={index}>
            {block.items.map((parts, item) => (
              <Text selectable key={item} style={styles.text}>
                {block.kind === "ol" ? `${item + 1}. ` : "• "}
                {inline(parts, names)}
              </Text>
            ))}
          </View>
        );
      })}
    </View>
  );
};
