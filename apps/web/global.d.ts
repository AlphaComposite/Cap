declare type MaybePromise<T> = T | Promise<T>;

declare type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;
