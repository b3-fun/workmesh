import React from 'react';
import { Icon } from './Icon.js';
export const IconChevronDownOutline18 = ({ strokeWidth = 1.5, ...props }) => {
    return (React.createElement(Icon, { size: "18px", ...props },
        React.createElement("polyline", { points: "15.25 6.5 9 12.75 2.75 6.5", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: strokeWidth })));
};
