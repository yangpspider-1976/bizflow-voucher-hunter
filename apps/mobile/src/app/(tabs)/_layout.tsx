import Feather from "@expo/vector-icons/Feather";
import { Tabs } from "expo-router";
import { StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts } from "@/theme";

/**
 * Feather, because the web's `CustomerBottomNav` uses `react-icons/fi` — the same
 * icon set — so home/bag/ellipsis render identically on both clients.
 */
function TabIcon({
  focused,
  name,
}: {
  focused: boolean;
  name: keyof typeof Feather.glyphMap;
}) {
  return (
    <Feather
      color={focused ? colors.primary : colors.textMuted}
      name={name}
      size={22}
    />
  );
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const t = useTranslation();
  // A fixed bar height puts the labels under the gesture pill on devices with
  // gesture navigation, so the inset is added to the bar rather than assumed away.
  const bottomInset = insets.bottom;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // Already the navigator's default; stated so a future upstream change
        // to that default cannot start sliding the scenes. A tab bar is a place
        // picker, not a journey — the destination should simply be there.
        animation: "none",
        sceneStyle: { backgroundColor: colors.page },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: styles.label,
        tabBarStyle: [
          styles.tabBar,
          { height: 74 + bottomInset, paddingBottom: 10 + bottomInset },
        ],
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("tab.home"),
          tabBarIcon: ({ focused }) => <TabIcon focused={focused} name="home" />,
        }}
      />
      {/* Levels, missions and achievements. Second, not last: it is the screen
          the app wants opened daily, and burying it behind More would make the
          daily habit the hardest thing to reach. */}
      <Tabs.Screen
        name="quests"
        options={{
          title: t("tab.quests"),
          tabBarIcon: ({ focused }) => <TabIcon focused={focused} name="award" />,
        }}
      />
      <Tabs.Screen
        name="vouchers"
        options={{
          title: t("tab.vouchers"),
          tabBarIcon: ({ focused }) => <TabIcon focused={focused} name="shopping-bag" />,
        }}
      />
      {/* One button for the whole storefront: the stack behind it (partners →
          items → checkout) is a single route as far as the bar is concerned. */}
      <Tabs.Screen
        name="shop"
        options={{
          title: t("tab.shop"),
          tabBarIcon: ({ focused }) => <TabIcon focused={focused} name="gift" />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t("tab.more"),
          tabBarIcon: ({ focused }) => <TabIcon focused={focused} name="more-horizontal" />,
        }}
      />
      {/* Lives inside the navigator so the bottom bar stays put through the hunt —
          the web renders its BottomNav on every step — but gets no tab button. */}
      <Tabs.Screen name="campaign/[slug]" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    paddingTop: 7,
  },
  label: {
    fontSize: 12,
    fontFamily: fonts.bold,
  },
});
