import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { HomeBackButton } from '@/components/home-back-button';
import { ProfileButton } from '@/components/profile-button';
import { AuthProvider } from '@/lib/auth';

SplashScreen.preventAutoHideAsync();

/**
 * Root layout.
 *
 * Auth routing is deliberately NOT done here. The launch decision lives in
 * `index.tsx` and each screen guards itself with a `<Redirect>`, so there is no
 * window where a screen renders before the session is known. This layout only
 * provides the session to everything below it.
 *
 * `AnimatedSplashOverlay` owns `SplashScreen.hideAsync()` - keep it mounted or the
 * native splash never lifts.
 */
export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AuthProvider>
        <AnimatedSplashOverlay />
        <Stack
          screenOptions={{
            // Every authenticated screen gets the profile button by default -
            // the profile screen itself turns it back off below. Screens with
            // headerShown: false (index, sign-in) never render a header at all,
            // so this default never reaches them - that is what keeps it off
            // the sign-in/sign-up screen without a special case for it here.
            headerRight: () => <ProfileButton />,
          }}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
          <Stack.Screen name="houses/index" options={{ title: 'Your Houses' }} />
          {/*
            headerLeft on these, and on profile below: their back button would
            otherwise read "< Your Houses" (the native default - the previous
            screen's title), replaced with a home icon that does the same thing.
            See HomeBackButton. The live-game screen a level further in keeps
            its ordinary back button, since that one was never "Your Houses".
          */}
          <Stack.Screen
            name="houses/new"
            options={{ title: 'Start a house', headerLeft: () => <HomeBackButton /> }}
          />
          <Stack.Screen
            name="houses/join"
            options={{ title: 'Join a house', headerLeft: () => <HomeBackButton /> }}
          />
          {/* Title is set by the screen once the house name is loaded. */}
          <Stack.Screen name="houses/[id]/index" options={{ headerLeft: () => <HomeBackButton /> }} />
          {/* Title toggles between "Live game" and "Settle game" within the screen. */}
          <Stack.Screen name="houses/[id]/game/[gameId]" />
          {/* The one screen the profile button is deliberately absent from. */}
          <Stack.Screen
            name="profile"
            options={{
              title: 'Profile',
              headerRight: () => null,
              headerLeft: () => <HomeBackButton />,
            }}
          />
        </Stack>
      </AuthProvider>
    </ThemeProvider>
  );
}
