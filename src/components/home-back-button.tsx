import { useRouter } from 'expo-router';
import { Pressable } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useTheme } from '@/hooks/use-theme';

/**
 * The white capsule around this button is native iOS chrome (react-native-screens'
 * `backButtonInCustomView`, which Expo Router enables under the hood for a custom
 * `headerLeft`) - not a view this file draws, so there is no "capsule width" prop
 * to set directly. It sizes itself around this component's own content frame, so
 * padding here is the actual lever: raise this to push the capsule's right edge
 * outward: adds empty space to the right of the icon without moving the icon
 * itself or affecting the left side.
 */
const RIGHT_EDGE_PADDING = 6;

/**
 * Replaces the native header's default back button - which would otherwise show
 * "< Your Houses", the previous screen's title - with "< <home icon>" that does
 * the exact same thing. Used as `headerLeft` on every screen one level under the
 * houses list (see _layout.tsx); the live-game screen is a level further in and
 * keeps its ordinary "< <house name>" back button, since that was never "Your
 * Houses" to begin with.
 *
 * The chevron and the house are ONE Svg, not two React Native views laid out
 * side by side. A two-view flex row looked fine in isolation but drifted
 * visibly off-centre once the native header wrapped it in its own back-button
 * container (an iOS pill/circle this component does not control the size of) -
 * a single graphic has no such interaction to go wrong, since the wrapper is
 * then centring exactly one fixed-proportion image, the same way it centred a
 * single icon correctly before the chevron was added back.
 *
 * The house's two paths are copied from HomeIcon (itself copied from
 * assets/images/Home-2--Streamline-Guidance-Free.svg), shifted +16 on the x-axis
 * to sit to the right of the chevron in one shared 40x24 viewBox - keep the two
 * in sync if that source icon ever changes.
 */
export function HomeBackButton() {
  const router = useRouter();
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back to your houses"
      onPress={() => router.back()}
      hitSlop={8}
      style={{ paddingRight: RIGHT_EDGE_PADDING }}>
      <Svg width={40} height={24} viewBox="0 0 40 24" fill="none">
        <Path
          d="M9 3 L3 12 L9 21"
          stroke={theme.text}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path
          stroke={theme.text}
          strokeWidth={1}
          d="M16.5 11.5v-0.25l1.335 -1.128a14 14 0 0 0 4.366 -6.636L22.5 2.5h11l0.302 1.005a14 14 0 0 0 4.388 6.683l1.26 1.062 0.05 0.05v10.2H16.5v-10Zm0 0h10.75l0.25 -0.208V21.5m6 0V17"
        />
        <Path
          stroke={theme.text}
          strokeWidth={1}
          d="M27.5 11.292c2.512 -2.093 4.741 -4.597 5.698 -7.787L33.5 2.5"
        />
      </Svg>
    </Pressable>
  );
}
