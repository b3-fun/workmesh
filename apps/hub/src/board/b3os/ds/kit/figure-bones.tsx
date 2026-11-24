// A figure strip's skeleton (skeleton.tsx re-exports it), in a module of its own: only a page that draws figures loads the
// strip and the glyph plates.
import { Icon, type IconName } from "../../ui/Icon";
import { IconTile } from "../layout/node-icon-tile";
import { Bone, TextBone } from "./bone";
import { FigureStrip } from "./figure-strip";
import "./css/lite.css";
import "./kit.css";

/** What a figure carries, so its skeleton is drawn in the figure's own shape (Figure's props, as booleans). */
export interface FigureShape {
  /**
   * The figure's label, when the page knows it before any read: the words themselves drawn as the bone (TextBone, in the
   * label's own font), so a label that wraps wraps in the skeleton too, exactly where it will.
   */
  label?: string;
  /** The glyph plate: `true` a plate's bone; a glyph's name, its own plate (drawn with `head: "shown"`). */
  icon?: boolean | IconName;
  /**
   * "shown": the head as it will be (the glyph on its plate, the label in ink), only the numbers bones: a page whose
   * figures' heads are known before any read (Home). Default "bone".
   */
  head?: "bone" | "shown";
  trend?: "spark" | "bars";
  sub?: boolean;
  progress?: boolean;
}

/**
 * A FigureStrip's shape, figure for figure, built from the figure's own parts (its head with the glyph plate, the value
 * with its spark or mini bars, the line under it, the limit line), each bone set in that part's line height, so the
 * skeleton is exactly as tall as the strip it stands for and nothing moves when the figures land.
 */
export function SkeletonFigures({ count = 4, shapes }: { count?: number; shapes?: readonly FigureShape[] }) {
  const list: readonly FigureShape[] = shapes ?? Array.from({ length: count }, () => ({ sub: true }));
  return (
    <div aria-busy="true" data-kit-skeleton="">
      <span className="sr-only" role="status">
        Loading figures
      </span>
      <FigureStrip>
        {list.map((f, i) => {
          const shown = f.head === "shown";
          return (
            <div key={i} className="kit-figure" aria-hidden={shown ? "true" : undefined}>
              <span className="kit-figure__head">
                {shown && typeof f.icon === "string" ? (
                  <IconTile size="xs" className="kit-figure__tile">
                    <Icon name={f.icon} size={15} />
                  </IconTile>
                ) : f.icon ? (
                  <Bone className="kit-bone--tile flex-none" />
                ) : null}
                <span className="kit-figure__label">
                  {f.label ? (
                    shown ? (
                      f.label
                    ) : (
                      <TextBone>{f.label}</TextBone>
                    )
                  ) : (
                    <Bone className="kit-bone--inline w-24" />
                  )}
                </span>
              </span>
              <span className="kit-figure__row">
                <span className="kit-figure__value">
                  <Bone className="kit-bone--inline kit-bone--value w-20" />
                </span>
                {f.trend === "spark" ? (
                  <span className="kit-figure__trend">
                    <Bone className="kit-bone--spark" />
                  </span>
                ) : f.trend === "bars" ? (
                  <span className="kit-figure__bars">
                    {Array.from({ length: 7 }, (_, j) => (
                      <Bone key={j} className="kit-figure__bar kit-bone--bar" />
                    ))}
                  </span>
                ) : null}
              </span>
              {f.sub !== false ? (
                <span className="kit-figure__sub">
                  <Bone className="kit-bone--inline kit-bone--sub w-28" />
                </span>
              ) : null}
              {f.progress ? <span className="kit-figure__progress" /> : null}
            </div>
          );
        })}
      </FigureStrip>
    </div>
  );
}
