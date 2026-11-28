import Svg, { Path } from "react-native-svg";

/** Tabler icons (the web app's set), outline, line 1.75. */
type IconProps = { color: string; size?: number; strokeWidth?: number };

function Icon({ color, size = 24, strokeWidth = 1.75, paths }: IconProps & { paths: string[] }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {paths.map((d) => (
        <Path key={d} d={d} />
      ))}
    </Svg>
  );
}

export function ConversationsIcon(props: IconProps) {
  return (
    <Icon
      {...props}
      paths={[
        "M21 14l-3 -3h-7a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1h9a1 1 0 0 1 1 1v10",
        "M14 15v2a1 1 0 0 1 -1 1h-7l-3 3v-10a1 1 0 0 1 1 -1h2",
      ]}
    />
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Icon
      {...props}
      paths={["M5 12l-2 0l9 -9l9 9l-2 0", "M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7", "M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"]}
    />
  );
}

export function BotsIcon(props: IconProps) {
  return (
    <Icon
      {...props}
      paths={[
        "M6 6a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -4",
        "M12 2v2",
        "M9 12v9",
        "M15 12v9",
        "M5 16l4 -2",
        "M15 14l4 2",
        "M9 18h6",
        "M10 8v.01",
        "M14 8v.01",
      ]}
    />
  );
}

export function CloudOffIcon(props: IconProps) {
  return (
    <Icon
      {...props}
      paths={[
        "M9.58 5.548c.24 -.11 .492 -.207 .752 -.286c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 .957 -.383 1.824 -1.003 2.454m-2.997 1.033h-11.343c-2.572 -.004 -4.657 -2.011 -4.657 -4.487c0 -2.475 2.085 -4.482 4.657 -4.482c.13 -.582 .37 -1.128 .7 -1.62",
        "M3 3l18 18",
      ]}
    />
  );
}
