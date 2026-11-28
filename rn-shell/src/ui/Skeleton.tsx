import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  type LayoutChangeEvent,
  StyleSheet,
  View,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import type { Colors } from "./theme";

/**
 * The loading skeleton: app-like placeholder shapes with a highlight sweeping left to right (a gentle
 * pulse when Reduce Motion is on). It is drawn in the same frame as the web view it covers, takes
 * every touch while it shows, and has no fade in, so no frame ever shows an empty web view.
 */
export function Skeleton(props: { colors: Colors; background: string }) {
  const { colors } = props;
  const [width, setWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const sweep = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => alive && setReduceMotion(value),
    );
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    const animation = reduceMotion
      ? Animated.loop(
          Animated.sequence([
            Animated.timing(pulse, {
              toValue: 0.6,
              duration: 900,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(pulse, {
              toValue: 1,
              duration: 900,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
          ]),
        )
      : Animated.loop(
          Animated.timing(sweep, {
            toValue: 1,
            duration: 1300,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
        );
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, sweep, pulse]);

  const band = Math.max(width * 0.6, 120);
  const translateX = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: [-band, width + band],
  });
  const shape = colors.muted;
  const highlight = colors.dark
    ? "rgba(255,255,255,0.07)"
    : "rgba(255,255,255,0.65)";

  return (
    <View
      testID="loading-skeleton"
      accessible
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
      onStartShouldSetResponder={() => true}
      onLayout={(event: LayoutChangeEvent) =>
        setWidth(event.nativeEvent.layout.width)
      }
      style={[
        StyleSheet.absoluteFill,
        styles.root,
        { backgroundColor: props.background },
      ]}
    >
      <Animated.View style={[styles.shapes, { opacity: pulse }]}>
        <View style={styles.header}>
          <View style={[styles.circle, { backgroundColor: shape }]} />
          <View
            style={[styles.line, { width: "38%", backgroundColor: shape }]}
          />
        </View>
        <View
          style={[
            styles.line,
            { width: "62%", height: 22, marginTop: 28, backgroundColor: shape },
          ]}
        />
        <View
          style={[
            styles.line,
            { width: "84%", marginTop: 12, backgroundColor: shape },
          ]}
        />
        {[0, 1, 2].map((row) => (
          <View
            key={row}
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <View style={[styles.tile, { backgroundColor: shape }]} />
            <View style={styles.cardLines}>
              <View
                style={[styles.line, { width: "70%", backgroundColor: shape }]}
              />
              <View
                style={[
                  styles.line,
                  { width: "45%", marginTop: 8, backgroundColor: shape },
                ]}
              />
            </View>
          </View>
        ))}
        <View style={styles.spacer} />
        <View
          style={[
            styles.composer,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        />
      </Animated.View>
      {reduceMotion || width === 0 ? null : (
        <Animated.View
          pointerEvents="none"
          style={[styles.band, { width: band, transform: [{ translateX }] }]}
        >
          <Svg width={band} height="100%">
            <Defs>
              <LinearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={highlight} stopOpacity="0" />
                <Stop offset="0.5" stopColor={highlight} stopOpacity="1" />
                <Stop offset="1" stopColor={highlight} stopOpacity="0" />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width={band} height="100%" fill="url(#sweep)" />
          </Svg>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { overflow: "hidden" },
  shapes: { flex: 1, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  circle: { width: 32, height: 32, borderRadius: 16 },
  line: { height: 12, borderRadius: 6 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 16,
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tile: { width: 32, height: 32, borderRadius: 8 },
  cardLines: { flex: 1, marginLeft: 12 },
  spacer: { flex: 1 },
  composer: {
    height: 96,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  band: { position: "absolute", top: 0, bottom: 0, left: 0 },
});
