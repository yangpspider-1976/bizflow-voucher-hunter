import { Stack } from "expo-router";

import { colors } from "@/theme";

/**
 * The quests stack: the board, then the two places it drills into. Grouped so
 * the tab bar has one route to point at rather than three buttons for what is
 * really one destination.
 */
export default function QuestsLayout() {
  return (
    <Stack
      initialRouteName="index"
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.page },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="level-up" />
      <Stack.Screen name="achievements" />
    </Stack>
  );
}
