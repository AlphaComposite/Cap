import { createBreadcrumbSchema } from "@/utils/web-schema";

export { metadata } from "./metadata";

const breadcrumbSchema = createBreadcrumbSchema([
	{ name: "Home", url: "https://cap.so" },
	{ name: "Tools", url: "https://cap.so/tools" },
	{ name: "Trim Video Online", url: "https://cap.so/tools/trim" },
]);

export default function TrimLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(breadcrumbSchema).replace(/</g, "\\u003c")}
			</script>
			{children}
		</>
	);
}
