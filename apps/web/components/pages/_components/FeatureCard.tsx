import Image from "next/image";

interface FeatureCardProps {
	title: string;
	description: string;
	imagePath: string;
	imageAlt?: string;
	bg?: string;
	className?: string;
	imageHeight?: string;
}

export const FeatureCard: React.FC<FeatureCardProps> = ({
	title,
	description,
	imagePath,
	imageAlt,
	className,
	bg,
	imageHeight = "h-48",
}) => {
	return (
		<div
			style={{
				backgroundImage: `url(${bg})`,
			}}
			className={`bg-gray-2 rounded-xl border border-gray-4 p-8 pt-0 h-full backdrop-blur-md relative z-10 flex flex-col overflow-hidden ${className}`}
		>
			<div className={`relative mt-10 mb-6 w-full rounded-lg ${imageHeight}`}>
				<Image
					src={imagePath}
					alt={imageAlt || title}
					fill
					sizes="(max-width: 768px) 100vw, 65vw"
					className="object-contain rounded-lg"
				/>
			</div>
			<h3 className="text-[1.25rem] leading-[1.5rem] font-semibold mb-1">
				{title}
			</h3>
			<p className="text-[1rem] leading-[1.5rem] text-[#151515/60] mb-0 max-w-lg">
				{description}
			</p>
		</div>
	);
};
