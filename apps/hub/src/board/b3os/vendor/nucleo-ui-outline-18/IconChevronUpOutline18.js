import React from 'react';
import { Icon } from './Icon.js';
export const IconChevronUpOutline18 = ({ strokeWidth = 1.5, ...props }) => {
    return (React.createElement(Icon, { size: "18px", ...props },
        React.createElement("polyline", { points: "2.75 11.5 9 5.25 15.25 11.5", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: strokeWidth })));
};
