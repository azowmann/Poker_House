import Svg, { Path } from 'react-native-svg';

type UserIconProps = {
  color: string;
  size?: number;
};

/**
 * Copied directly from assets/images/User-1--Streamline-Guidance-Free.svg
 * (Streamline's "User 1" icon), the same way HomeIcon copies its source file -
 * see that component for why this isn't a `.svg` import.
 */
export function UserIcon({ color, size = 24 }: UserIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        stroke={color}
        strokeWidth={1}
        d="M18.5 20.247V16S16 14.5 12 14.5 5.5 16 5.5 16v4.247M1.5 12C1.5 6.201 6.201 1.5 12 1.5S22.5 6.201 22.5 12 17.799 22.5 12 22.5 1.5 17.799 1.5 12Zm10.426 0.5S8.5 10.68 8.5 8c0 -1.933 1.569 -3.5 3.504 -3.5A3.495 3.495 0 0 1 15.5 8c0 2.68 -3.426 4.5 -3.426 4.5h-0.148Z"
      />
    </Svg>
  );
}
