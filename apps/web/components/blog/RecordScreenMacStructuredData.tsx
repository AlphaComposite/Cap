"use client";

import Script from "next/script";
import { serializeStateForScript } from "@/lib/desktop-session";
import { recordScreenMacContent } from "../../content/blog-content/record-screen-mac-system-audio";

// Create Article structured data for SEO
const createArticleStructuredData = () => {
	const articleStructuredData = {
		"@context": "https://schema.org",
		"@type": "BlogPosting",
		headline: recordScreenMacContent.title,
		description: recordScreenMacContent.description,
		author: {
			"@type": "Person",
			name: recordScreenMacContent.author,
		},
		datePublished: recordScreenMacContent.publishedAt,
		image: recordScreenMacContent.videoDemo?.videoSrc,
		keywords: recordScreenMacContent.tags.join(","),
		mainEntityOfPage: {
			"@type": "WebPage",
			"@id": "https://cap.so/blog/record-screen-mac-system-audio",
		},
	};

	return serializeStateForScript(articleStructuredData);
};

// Create FAQ structured data for SEO
const createFaqStructuredData = () => {
	const faqStructuredData = {
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: recordScreenMacContent.faqs.map((faq) => ({
			"@type": "Question",
			name: faq.question,
			acceptedAnswer: {
				"@type": "Answer",
				text: faq.answer.replace(/<\/?[^>]+(>|$)/g, ""),
			},
		})),
	};

	return serializeStateForScript(faqStructuredData);
};

export const RecordScreenMacStructuredData = () => {
	return (
		<>
			{/* biome-ignore lint/correctness/useUniqueElementIds: Canonical article identity preserves Next Script dedup on repeat mounts while remaining distinct from other routes and schemas. */}
			<Script
				id="blog-record-screen-mac-system-audio-article-structured-data"
				type="application/ld+json"
			>
				{createArticleStructuredData()}
			</Script>
			{/* biome-ignore lint/correctness/useUniqueElementIds: Canonical blog FAQ identity is distinct from the article and other routes in Next Script's cache. */}
			<Script
				id="blog-record-screen-mac-system-audio-faq-structured-data"
				type="application/ld+json"
			>
				{createFaqStructuredData()}
			</Script>
		</>
	);
};
