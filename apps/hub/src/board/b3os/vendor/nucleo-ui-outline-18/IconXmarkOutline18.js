import React from 'react';
import { Icon } from './Icon.js';
export const IconXmarkOutline18 = ({ strokeWidth = 1.5, ...props }) => {
    return (React.createElement(Icon, { size: "18px", ...props },
        React.createElement("line", { x1: "14", y1: "4", x2: "4", y2: "14", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: strokeWidth, "data-color": "color-2" }),
        React.createElement("line", { x1: "4", y1: "4", x2: "14", y2: "14", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: strokeWidth })));
};
