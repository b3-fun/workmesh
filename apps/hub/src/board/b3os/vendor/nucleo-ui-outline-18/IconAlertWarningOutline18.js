import React from 'react';
import { Icon } from './Icon.js';
export const IconAlertWarningOutline18 = ({ strokeWidth = 1.5, ...props }) => {
    return (React.createElement(Icon, { size: "18px", ...props },
        React.createElement("line", { x1: "9", y1: "2.75", x2: "9", y2: "10.75", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: strokeWidth }),
        React.createElement("path", { d: "M9,16c.551,0,1-.449,1-1s-.449-1-1-1-1,.449-1,1,.449,1,1,1Z", fill: "currentColor", "data-color": "color-2", "data-stroke": "none" })));
};
