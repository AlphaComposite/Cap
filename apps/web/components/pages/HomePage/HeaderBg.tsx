"use client";

import { useId } from "react";

const HeaderBg = () => {
	const id = useId();
	return (
		<svg
			aria-hidden="true"
			className="absolute top-0 left-0 pointer-events-none z-[10]"
			width="1440"
			height="690"
			viewBox="0 0 1440 690"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<g filter={`url(#${id}-filter0)`}>
				<ellipse
					cx="491"
					cy="339"
					rx="584"
					ry="251"
					transform="rotate(180 491 339)"
					fill={`url(#${id}-paint0)`}
				/>
			</g>
			<g
				style={{
					mixBlendMode: "plus-lighter",
					opacity: "0.5",
				}}
				filter={`url(#${id}-filter1)`}
			>
				<ellipse
					cx="293.5"
					cy="328.5"
					rx="375.5"
					ry="77.5"
					transform="rotate(180 293.5 328.5)"
					fill={`url(#${id}-paint1)`}
				/>
			</g>
			<g filter={`url(#${id}-filter2)`}>
				<ellipse
					cx="947"
					cy="154"
					rx="584"
					ry="251"
					fill={`url(#${id}-paint2)`}
				/>
			</g>
			<g
				style={{
					mixBlendMode: "plus-lighter",
					opacity: "0.5",
				}}
				opacity="0.5"
				filter={`url(#${id}-filter3)`}
			>
				<ellipse
					cx="215"
					cy="77.5"
					rx="215"
					ry="77.5"
					transform="matrix(1 0 0 -1 1088 251)"
					fill={`url(#${id}-paint3)`}
				/>
			</g>
			<defs>
				<filter
					id={`${id}-filter0`}
					x="-193"
					y="-12"
					width="1368"
					height="702"
					filterUnits="userSpaceOnUse"
					color-interpolation-filters="sRGB"
				>
					<feFlood flood-opacity="0" result="BackgroundImageFix" />
					<feBlend
						mode="normal"
						in="SourceGraphic"
						in2="BackgroundImageFix"
						result="shape"
					/>
					<feGaussianBlur
						stdDeviation="50"
						result="effect1_foregroundBlur_459_2096"
					/>
				</filter>
				<filter
					id={`${id}-filter1`}
					x="-152"
					y="181"
					width="891"
					height="295"
					filterUnits="userSpaceOnUse"
					color-interpolation-filters="sRGB"
				>
					<feFlood flood-opacity="0" result="BackgroundImageFix" />
					<feBlend
						mode="normal"
						in="SourceGraphic"
						in2="BackgroundImageFix"
						result="shape"
					/>
					<feGaussianBlur
						stdDeviation="35"
						result="effect1_foregroundBlur_459_2096"
					/>
				</filter>
				<filter
					id={`${id}-filter2`}
					x="263"
					y="-197"
					width="1368"
					height="702"
					filterUnits="userSpaceOnUse"
					color-interpolation-filters="sRGB"
				>
					<feFlood flood-opacity="0" result="BackgroundImageFix" />
					<feBlend
						mode="normal"
						in="SourceGraphic"
						in2="BackgroundImageFix"
						result="shape"
					/>
					<feGaussianBlur
						stdDeviation="50"
						result="effect1_foregroundBlur_459_2096"
					/>
				</filter>
				<filter
					id={`${id}-filter3`}
					x="1018"
					y="26"
					width="570"
					height="295"
					filterUnits="userSpaceOnUse"
					color-interpolation-filters="sRGB"
				>
					<feFlood flood-opacity="0" result="BackgroundImageFix" />
					<feBlend
						mode="normal"
						in="SourceGraphic"
						in2="BackgroundImageFix"
						result="shape"
					/>
					<feGaussianBlur
						stdDeviation="35"
						result="effect1_foregroundBlur_459_2096"
					/>
				</filter>
				<linearGradient
					id={`${id}-paint0`}
					x1="1001.5"
					y1="339"
					x2="56.5"
					y2="375.5"
					gradientUnits="userSpaceOnUse"
				>
					<stop stop-color="#75A3FE" />
					<stop offset="1" stop-color="white" stop-opacity="0" />
				</linearGradient>
				<linearGradient
					id={`${id}-paint1`}
					x1="615.5"
					y1="349"
					x2="15.8448"
					y2="376.824"
					gradientUnits="userSpaceOnUse"
				>
					<stop stop-color="white" />
					<stop offset="1" stop-color="white" stop-opacity="0" />
				</linearGradient>
				<linearGradient
					id={`${id}-paint2`}
					x1="1457.5"
					y1="154"
					x2="512.5"
					y2="190.5"
					gradientUnits="userSpaceOnUse"
				>
					<stop stop-color="#A6D7FF" />
					<stop offset="1" stop-color="white" stop-opacity="0" />
				</linearGradient>
				<linearGradient
					id={`${id}-paint3`}
					x1="399.368"
					y1="98"
					x2="55.5264"
					y2="107.135"
					gradientUnits="userSpaceOnUse"
				>
					<stop stop-color="white" />
					<stop offset="1" stop-color="white" stop-opacity="0" />
				</linearGradient>
			</defs>
		</svg>
	);
};

export default HeaderBg;
