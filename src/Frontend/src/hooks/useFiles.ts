import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { apiFileToFileItem, FileItem } from '@/components/types';

export const useFiles = () => {
    const query = useQuery({
        queryKey: ['files'],
        queryFn: async () => {
            const response = await api.fetchFiles();
            return response.files.map(apiFileToFileItem);
        },
        staleTime: 1000 * 60 * 5, // 5 minutes
        refetchOnWindowFocus: true,
    });

    return {
        files: query.data || [],
        isLoading: query.isLoading,
        isError: query.isError,
        error: query.error,
        refetch: query.refetch,
    };
};
