import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

// Never actually fires - hydration status doesn't change again after mount - but
// useSyncExternalStore requires a subscribe function.
const subscribe = () => () => {};

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web
 *
 * `useSyncExternalStore` is the mechanism React itself provides for a value that
 * differs between the server/static render and the client (its third argument,
 * `getServerSnapshot`, exists for exactly this). It forces the one hydration
 * re-render this needs without a `useState` + `useEffect` pair, which trips
 * `react-hooks/set-state-in-effect` - setting state synchronously inside an
 * effect, right after the component that owns it has just rendered.
 */
export function useColorScheme() {
  const hasHydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );

  const colorScheme = useRNColorScheme();

  if (hasHydrated) {
    return colorScheme;
  }

  return 'light';
}
