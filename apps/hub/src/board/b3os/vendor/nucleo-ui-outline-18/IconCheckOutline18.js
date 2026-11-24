import React from 'react';
import { Icon } from './Icon.js';
export const IconCheckOutline18 = ({ strokeWidth = 1.5, ...props }) => {
    return (React.createElement(Icon, { size: "18px", ...props },
        React.createElement("polyline", { points: "2.75 9.25 6.75 14.25 15.25 3.75", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: strokeWidth })));
};
