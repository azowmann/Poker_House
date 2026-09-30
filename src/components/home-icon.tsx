import Svg, { Path } from 'react-native-svg';

type HomeIconProps = {
  color: string;
  size?: number;
};

/**
 * The two paths below are copied directly from
 * assets/images/Home-2--Streamline-Guidance-Free.svg (Streamline's "Home 2"
 * icon), with the hardcoded `stroke="#000000"` lifted out into a `color` prop so
 * it can follow the app's theme - the source file is plain black, which would be
 * invisible in a dark header.
 *
 * Rendered with react-native-svg's own primitives rather than loading the .svg
 * file itself: this project has no Metro transformer configured for treating
 * .svg imports as components, and adding one is more machinery than a single
 * fixed icon needs.
 */
export function HomeIcon({ color, size = 24 }: HomeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        stroke={color}
        strokeWidth={1}
        d="M0.5 11.5v-0.25l1.335 -1.128a14 14 0 0 0 4.366 -6.636L6.5 2.5h11l0.302 1.005a14 14 0 0 0 4.388 6.683l1.26 1.062 0.05 0.05v10.2H0.5v-10Zm0 0h10.75l0.25 -0.208V21.5m6 0V17"
      />
      <Path stroke={color} strokeWidth={1} d="M11.5 11.292c2.512 -2.093 4.741 -4.597 5.698 -7.787L17.5 2.5" />
    </Svg>
  );
}
